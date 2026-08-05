import { spawn } from 'node:child_process';
import { assistantBase } from './gemini.js';
import { geminiWriteLimiter } from './rateLimiter.js';
import { logger } from '../logger.js';
import { createDataStore, addTargetSite, dataStoreResourcePath } from './geminiDataStore.js';
import { sanitizeDataStoreId } from './knowledgePlanner.js';
import { isPublicWebsiteKind } from './knowledgeClassifier.js';
import type { AgentIR, GeminiDestination, KnowledgeSourceIR } from '../types.js';

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
  /**
   * Full Discovery Engine resource paths of data stores this agent should
   * ground on via ADK's VertexAiSearchTool — a website data store (see
   * createWebsiteGroundingDataStore) and/or "document" data stores for
   * locally-uploaded files (see knowledgeDataStoreExecutor.migrateFileToDocumentStore).
   * VertexAiSearchTool is the ONLY tool-based way to ground on either kind,
   * since Gemini Enterprise apps/engines refuse to attach a website store
   * directly (docs/knowledge-sources-migration-playbook.md §4.1), and ADK
   * agents have no agentFiles concept at all (decisions.md). One store →
   * adk_deploy.py wires `data_store_id`; more than one → `data_store_specs`
   * (both combine on a single VertexAiSearchTool instance). ADK currently
   * allows VertexAiSearchTool ONLY as the sole tool on an agent (pre-1.16
   * limitation), so when this is non-empty, `tools` above is ignored by
   * adk_deploy.py.
   *
   * ⚠️ Requires the Reasoning Engine's runtime service agent to have
   * Discovery Engine read access on the project (see
   * ensureReasoningEngineDiscoveryAccess below) — without it, the deployed
   * agent 403s at query time even though deployment itself succeeds.
   */
  groundingDataStores?: string[];
}

/**
 * Whether an agent should be created via the ADK path instead of the default
 * low-code path.
 *
 * ── TEMPORARILY DISABLED (Business-edition-only testing phase) ─────────────
 * This tool is currently scoped to Business-edition Gemini Enterprise projects
 * only. The Standard/Plus edition differentiation that used to live on
 * `GeminiDestination`/`Session` — and the resulting "edition needs ADK for
 * gallery visibility" trigger this function used to check — has been removed.
 * The other, edition-independent trigger this function used to also check
 * (a public-website knowledge source — no Gemini Enterprise app/engine can
 * attach a website data store; ADK's VertexAiSearchTool was the only working
 * path, see docs/knowledge-sources-migration-playbook.md §4.1) is dead here
 * too, forced off along with it.
 *
 * Restore from git history when Standard/Plus + website-grounding comes back
 * into scope — search history for `needsAdkDeployment` prior to this change.
 */
export function needsAdkDeployment(_dest: GeminiDestination, _ir: AgentIR): boolean {
  return false;
}

/** True if any of the agent's knowledge sources is a public website (Copilot's PublicSiteSearchSource). */
export function hasWebsiteKnowledgeSource(ir: AgentIR): boolean {
  return ir.knowledgeSources.some((k) => isPublicWebsiteKind(k.kind));
}

/** The first public-website knowledge source on the agent, if any — the one to ground an ADK deployment on. */
export function firstWebsiteSource(ir: AgentIR): KnowledgeSourceIR | undefined {
  return ir.knowledgeSources.find((k) => isPublicWebsiteKind(k.kind));
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
export function buildAdkSpec(
  ir: AgentIR,
  opts?: { model?: string; instruction?: string; groundingDataStores?: string[] },
): AdkSpec {
  const tools: string[] = [];
  if (ir.capabilities?.webBrowsing) tools.push('googleSearch');
  // Fidelity is being brought up in STAGES (behavior must not silently change):
  //   Stage 1 (now):  name + description + the REAL migrated instruction only.
  //   Stage 2 (next): fold in topic procedures (pass the enriched instruction via opts.instruction).
  //   Stage 3 (now):  every knowledge kind the migration engine already knows how
  //   to resolve into a Discovery Engine data store — uploaded files, public
  //   websites, Dataverse-table snapshots, SharePoint-connector stores — all via
  //   VertexAiSearchTool (opts.groundingDataStores). orchestrator.ts resolves all
  //   of them before deciding low-code vs ADK, so this path gets the same
  //   knowledge the low-code path would, not just the two kinds it used to.
  return {
    name: sanitize(ir.name),
    displayName: ir.name,                                              // Stage 1 ✓
    description: ir.description || `Migrated from Copilot Studio: ${ir.name}`, // Stage 1 ✓
    model: opts?.model || 'gemini-2.5-flash',
    instruction: opts?.instruction ?? ir.instructions ?? '',          // Stage 1 ✓ (real instruction; opts.instruction = Stage 2 enriched)
    tools,                                                            // only googleSearch for now (Stage 3 adds the rest)
    groundingDataStores: opts?.groundingDataStores?.length ? opts.groundingDataStores : undefined,
  };
}

/**
 * Create (idempotently) the BASIC-tier PUBLIC_WEBSITE data store that grounds a
 * migrated agent's public-website knowledge source via ADK's VertexAiSearchTool.
 * Deliberately basic, not advanced: advanced indexing needs Search Console
 * domain-ownership verification we don't control for a customer's site, and
 * VertexAiSearchTool doesn't require it — see geminiDataStore.ts createDataStore.
 *
 * Returns the full resource path buildAdkSpec/adk_deploy.py needs. Never
 * attaches to an engine — that path is proven broken for websites (see
 * docs/knowledge-sources-migration-playbook.md §4.1); ADK grounds on the data
 * store directly at inference time instead.
 */
export async function createWebsiteGroundingDataStore(
  project: string,
  saToken: string,
  agentSourceId: string,
  source: KnowledgeSourceIR,
): Promise<{ ok: boolean; resourcePath?: string; error?: string }> {
  const url = (source.references?.[0] ?? source.reference ?? '').trim();
  if (!url) return { ok: false, error: 'no URL captured for this source' };

  const dataStoreId = sanitizeDataStoreId(`${agentSourceId}-web-${source.id}`);
  const create = await createDataStore(project, saToken, {
    dataStoreId,
    displayName: `${source.name} (ADK website grounding — ${agentSourceId})`,
    kind: 'website',
    advanced: false,
  });
  if (!create.created && !create.alreadyExists) return { ok: false, error: create.error };

  const pattern = `${url.replace(/^https?:\/\//, '').replace(/\/$/, '')}/*`;
  const site = await addTargetSite(project, saToken, dataStoreId, pattern);
  if (!site.ok && !/already exists|ALREADY_EXISTS/i.test(site.error ?? '')) {
    return { ok: false, error: site.error };
  }

  return { ok: true, resourcePath: dataStoreResourcePath(project, dataStoreId) };
}

/**
 * Grants the Vertex AI Reasoning Engine's default runtime service agent
 * (`service-{project}@gcp-sa-aiplatform-re.iam.gserviceaccount.com` — Google-
 * managed, not ours) read access to Discovery Engine resources in this
 * project, so a deployed ADK agent's VertexAiSearchTool can actually query a
 * data store at inference time.
 *
 * WHY THIS EXISTS: live-verified 2026-08-03 — a Reasoning Engine agent with a
 * correctly-wired VertexAiSearchTool 403s on every query
 * (`discoveryengine.servingConfigs.search` denied) until this grant exists,
 * even though the data store itself was created and imported successfully by
 * OUR service account. The two identities are different: our SA creates the
 * data store, but Google's own Reasoning Engine service agent is what
 * actually executes the deployed agent and calls the search tool.
 *
 * ⚠️ Requires `resourcemanager.projects.{get,set}IamPolicy` on our SA for this
 * project — a MORE PRIVILEGED grant than anything else this tool asks a
 * customer for today (see docs/ADK-FILE-GROUNDING-PERMISSIONS.md). If the SA
 * lacks it (the expected case on most real customer projects unless granted
 * explicitly), this fails gracefully — callers must treat that as "grounding
 * may not work" and report it honestly, NOT crash the whole deployment.
 */
export async function ensureReasoningEngineDiscoveryAccess(
  project: string,
  saToken: string,
): Promise<{ ok: boolean; alreadyGranted?: boolean; error?: string }> {
  const serviceAgent = `service-${project}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`;
  const role = 'roles/discoveryengine.viewer';
  const member = `serviceAccount:${serviceAgent}`;

  const getRes = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!getRes.ok) {
    return { ok: false, error: `getIamPolicy ${getRes.status}: ${(await getRes.text()).slice(0, 200)}` };
  }
  const policy = (await getRes.json()) as { bindings?: { role: string; members: string[] }[] };
  policy.bindings = policy.bindings ?? [];
  const binding = policy.bindings.find((b) => b.role === role);
  if (binding?.members.includes(member)) return { ok: true, alreadyGranted: true };
  if (binding) binding.members.push(member);
  else policy.bindings.push({ role, members: [member] });

  const setRes = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}:setIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy }),
  });
  if (!setRes.ok) {
    return { ok: false, error: `setIamPolicy ${setRes.status}: ${(await setRes.text()).slice(0, 200)}` };
  }
  return { ok: true };
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
  opts?: {
    location?: string;
    model?: string;
    instruction?: string;
    stagingBucket?: string;
    /** A public-website knowledge source to ground this agent on via VertexAiSearchTool. */
    websiteSource?: KnowledgeSourceIR;
    /** Resource paths of data stores already resolved+imported by the caller
     *  BEFORE this call — uploaded files (migrateFileToDocumentStore),
     *  Dataverse-table snapshots, and/or SharePoint-connector stores (see
     *  orchestrator.ts, which resolves all knowledge sources before deciding
     *  low-code vs ADK so the SAME resolved stores can feed either path).
     *  orchestrator.ts needs the per-source success/failure detail for its
     *  own fidelity reporting, so resolution stays the caller's job. */
    groundingDataStores?: string[];
  },
): Promise<{
  ok: boolean;
  agentId?: string;
  reasoningEngine?: string;
  state?: string;
  error?: string;
  groundingIamGranted?: boolean;
  groundingIamError?: string;
  /** True when this agent's source had web browsing enabled but it got
   *  dropped: ADK (pre-1.16) only allows VertexAiSearchTool ALONE once any
   *  grounding data store is present (see AdkSpec.groundingDataStores doc).
   *  Caller must surface this as a fidelity note — never let it stay silent. */
  googleSearchDropped?: boolean;
}> {
  const location = opts?.location || process.env.ADK_LOCATION || 'us-central1';
  const agentSourceId = sanitize(ir.name);

  const groundingDataStores: string[] = [...(opts?.groundingDataStores ?? [])];
  if (opts?.websiteSource) {
    const grounding = await createWebsiteGroundingDataStore(dest.project, saToken, agentSourceId, opts.websiteSource);
    if (!grounding.ok) return { ok: false, error: `website grounding data store: ${grounding.error}` };
    if (grounding.resourcePath) groundingDataStores.push(grounding.resourcePath);
  }
  const googleSearchDropped = groundingDataStores.length > 0 && !!ir.capabilities?.webBrowsing;

  // Best-effort — a missing grant means degraded (ungrounded) search, not a
  // failed deployment. Caller reports this honestly via fidelity notes.
  let groundingIamGranted: boolean | undefined;
  let groundingIamError: string | undefined;
  if (groundingDataStores.length) {
    const iam = await ensureReasoningEngineDiscoveryAccess(dest.project, saToken);
    groundingIamGranted = iam.ok;
    groundingIamError = iam.error;
    if (!iam.ok) {
      logger.warn(
        { agent: ir.name, project: dest.project, error: iam.error },
        'adk: could not grant Reasoning Engine Discovery Engine access — grounding will 403 at query time until granted manually',
      );
    }
  }

  const spec = buildAdkSpec(ir, { model: opts?.model, instruction: opts?.instruction, groundingDataStores });
  logger.info({ agent: ir.name, location }, 'adk: deploying reasoning engine');
  const dep = await deployReasoningEngine(dest.project, location, spec, { stagingBucket: opts?.stagingBucket });
  if (!dep.ok || !dep.reasoningEngine) return { ok: false, error: `deploy: ${dep.error}` };
  logger.info({ agent: ir.name, reasoningEngine: dep.reasoningEngine }, 'adk: registering into engine');
  const reg = await registerAdkAgent(dest, saToken, {
    reasoningEngine: dep.reasoningEngine,
    displayName: spec.displayName,
    description: spec.description,
  });
  if (!reg.registered) return { ok: false, reasoningEngine: dep.reasoningEngine, error: `register: ${reg.error}`, groundingIamGranted, groundingIamError, googleSearchDropped };
  return { ok: true, agentId: reg.agentId, reasoningEngine: dep.reasoningEngine, state: reg.state, groundingIamGranted, groundingIamError, googleSearchDropped };
}
