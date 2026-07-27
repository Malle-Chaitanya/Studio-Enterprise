import { spawn } from 'node:child_process';
import { assistantBase } from './gemini.js';
import { geminiWriteLimiter } from './rateLimiter.js';
import { logger } from '../logger.js';
import type { AgentIR, GeminiDestination } from '../types.js';

/**
 * ADK / Agent-Runtime deploy path — the "publish to gallery" upgrade.
 *
 * WHY THIS EXISTS: on Gemini Enterprise Standard, low-code agents
 * (`lowCodeAgentDefinition`) are created `state: PRIVATE` and are NEVER listed
 * in the governed gallery — no API/console/IAM change moves them to `ENABLED`
 * (proven exhaustively; see docs/GEMINI-CHATBOT-CLAIMS-FACTCHECK.md). The ONLY
 * agents that list in the Standard gallery are Google built-ins and
 * `adkAgentDefinition` agents backed by a Vertex AI Agent Runtime (Reasoning
 * Engine) — those are created `state: ENABLED` automatically.
 *
 * So to make a migrated agent gallery-visible we take the SAME extracted
 * `AgentIR` and, instead of emitting a low-code definition, we:
 *   1. buildAdkSpec(ir)          → an ADK LlmAgent spec (instruction preserved)
 *   2. deployReasoningEngine()   → deploy it as a Reasoning Engine (Python SDK)
 *   3. registerAdkAgent()        → register it into the engine (REST) → ENABLED
 *
 * COST/OPS WARNING: each gallery agent = one always-on Reasoning Engine
 * (billable compute). This is an OPT-IN per-agent upgrade, NOT the default.
 * The low-code path stays the cheap default; only agents the customer chooses
 * to "publish to gallery" go through here.
 */

/** A platform-neutral ADK agent spec derived from the IR. Consumed by the
 *  Python deploy script (the Agent Engine SDK is Python-only). */
export interface AdkSpec {
  name: string; // sanitized identifier (no spaces)
  displayName: string;
  description: string;
  model: string; // GA model — NOT a preview id (preview + global-location hack fails to start)
  instruction: string; // the migrated instruction, verbatim
  tools: string[]; // e.g. ['googleSearch']
}

/** Sanitize a display name into a valid ADK agent identifier. */
function sanitize(name: string): string {
  return (name || 'agent').replace(/[^A-Za-z0-9_]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'agent';
}

/**
 * Derive an ADK agent spec from the migrated IR. The migrated instruction is
 * carried VERBATIM (same fidelity as the low-code path); web browsing maps to
 * the googleSearch tool. Uses a GA model by default.
 */
export function buildAdkSpec(ir: AgentIR, opts?: { model?: string; instruction?: string }): AdkSpec {
  const tools: string[] = [];
  if (ir.capabilities?.webBrowsing) tools.push('googleSearch');
  // Fidelity is being brought up in STAGES (behavior must not silently change):
  //   Stage 1 (now):  name + description + the REAL migrated instruction only.
  //   Stage 2 (next): fold in topic procedures (pass the enriched instruction via opts.instruction).
  //   Stage 3 (later): knowledge sources (data stores / files) + non-search tools.
  return {
    name: sanitize(ir.name),
    displayName: ir.name,                                              // Stage 1 ✓
    description: ir.description || `Migrated from Copilot Studio: ${ir.name}`, // Stage 1 ✓
    model: opts?.model || 'gemini-2.5-flash',
    instruction: opts?.instruction ?? ir.instructions ?? '',          // Stage 1 ✓ (real instruction; opts.instruction = Stage 2 enriched)
    tools,                                                            // only googleSearch for now (Stage 3 adds the rest)
  };
}

export interface DeployResult {
  ok: boolean;
  /** Full resource: projects/<p>/locations/<loc>/reasoningEngines/<id> */
  reasoningEngine?: string;
  error?: string;
}

/**
 * Deploy an ADK agent as a Vertex AI Reasoning Engine (Agent Runtime). This
 * shells out to a Python worker (`scripts/adk_deploy.py`) because Agent Engine
 * deployment is a Python-SDK-only flow (packages code + requirements + stages
 * to GCS + builds a container). The worker prints one JSON line:
 *   {"reasoningEngine": "projects/.../reasoningEngines/..."}  on success
 *   {"error": "..."}                                          on failure
 *
 * Deploy takes ~2-5 min. Callers should run this with low concurrency.
 */
export function deployReasoningEngine(
  project: string,
  location: string,
  spec: AdkSpec,
  opts?: { stagingBucket?: string; pythonBin?: string; scriptPath?: string; timeoutMs?: number },
): Promise<DeployResult> {
  const python = opts?.pythonBin || process.env.PYTHON_BIN || 'python';
  const script = opts?.scriptPath || 'scripts/adk_deploy.py';
  const args = [script, '--project', project, '--location', location, '--spec', JSON.stringify(spec)];
  if (opts?.stagingBucket || process.env.ADK_STAGING_BUCKET) {
    args.push('--staging-bucket', opts?.stagingBucket || process.env.ADK_STAGING_BUCKET!);
  }
  const timeoutMs = opts?.timeoutMs ?? 15 * 60_000;

  return new Promise((resolve) => {
    const child = spawn(python, args, { env: process.env });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { child.kill(); resolve({ ok: false, error: `deploy timed out after ${timeoutMs}ms` }); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString()));
    child.stderr.on('data', (d) => (err += d.toString()));
    child.on('close', (code) => {
      clearTimeout(timer);
      // The worker prints a JSON result on its LAST non-empty stdout line.
      const line = out.trim().split(/\r?\n/).filter(Boolean).pop() || '';
      try {
        const j = JSON.parse(line) as { reasoningEngine?: string; error?: string };
        if (j.reasoningEngine) return resolve({ ok: true, reasoningEngine: j.reasoningEngine });
        return resolve({ ok: false, error: j.error || `deploy failed (exit ${code}): ${err.slice(-300)}` });
      } catch {
        return resolve({ ok: false, error: `deploy produced no JSON result (exit ${code}): ${(err || out).slice(-300)}` });
      }
    });
  });
}

export interface RegisterResult {
  registered: boolean;
  agentId?: string;
  state?: string;
  error?: string;
}

/**
 * Register a deployed Reasoning Engine into the engine as an `adkAgentDefinition`
 * agent. PROVEN to return `state: ENABLED` (gallery-visible). This is the
 * gallery-critical step and it's pure REST.
 */
export async function registerAdkAgent(
  dest: GeminiDestination,
  saToken: string,
  args: { reasoningEngine: string; displayName: string; description: string },
): Promise<RegisterResult> {
  await geminiWriteLimiter.acquire(); // pace writes to avoid 429 bursts (same limiter as low-code path)
  const res = await fetch(`${assistantBase(dest)}/agents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: args.displayName,
      description: args.description,
      adkAgentDefinition: { provisionedReasoningEngine: { reasoningEngine: args.reasoningEngine } },
    }),
  });
  const text = await res.text();
  if (!res.ok) return { registered: false, error: `${res.status}: ${text.replace(/\s+/g, ' ').slice(0, 300)}` };
  const j = JSON.parse(text) as { name?: string; state?: string };
  return { registered: true, agentId: j.name?.split('/').pop(), state: j.state };
}

/**
 * Full "publish to gallery" for one migrated agent: IR → ADK spec → deploy
 * Reasoning Engine → register → ENABLED. Returns the gallery-visible agent id.
 * OPT-IN per agent (billable). Falls back to caller's low-code path on failure.
 */
export async function publishAgentToGallery(
  dest: GeminiDestination,
  saToken: string,
  ir: AgentIR,
  opts?: { location?: string; model?: string; instruction?: string; stagingBucket?: string },
): Promise<{ ok: boolean; agentId?: string; reasoningEngine?: string; state?: string; error?: string }> {
  const location = opts?.location || process.env.ADK_LOCATION || 'us-central1';
  const spec = buildAdkSpec(ir, { model: opts?.model, instruction: opts?.instruction });
  logger.info({ agent: ir.name, location }, 'adk: deploying reasoning engine');
  const dep = await deployReasoningEngine(dest.project, location, spec, { stagingBucket: opts?.stagingBucket });
  if (!dep.ok || !dep.reasoningEngine) return { ok: false, error: `deploy: ${dep.error}` };
  logger.info({ agent: ir.name, reasoningEngine: dep.reasoningEngine }, 'adk: registering into engine');
  const reg = await registerAdkAgent(dest, saToken, {
    reasoningEngine: dep.reasoningEngine,
    displayName: spec.displayName,
    description: spec.description,
  });
  if (!reg.registered) return { ok: false, reasoningEngine: dep.reasoningEngine, error: `register: ${reg.error}` };
  return { ok: true, agentId: reg.agentId, reasoningEngine: dep.reasoningEngine, state: reg.state };
}
