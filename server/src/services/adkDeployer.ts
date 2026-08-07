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
   * agents have no agentFiles concept at all (decisions.md). adk_deploy.py
   * wires ONE VertexAiSearchTool per resource path here (not a single tool
   * combining all of them via `data_store_specs` — the installed ADK SDK's
   * own constructor requires exactly one of `data_store_id`/`search_engine_id`
   * per instance; `data_store_specs` is a scoping filter valid only alongside
   * `search_engine_id`, not a way to combine independent stores — see
   * `scripts/adk_deploy.py`'s 2026-08-05 fix). Each instance sets
   * `bypass_multi_tools_limit=True`, which this ADK version (2.5.0, not the
   * pre-1.16 this comment used to assume) uses to let multiple
   * VertexAiSearchTool instances — and potentially `tools` above too —
   * coexist on one agent instead of rejecting the combination; not yet wired
   * to actually combine with `tools` in this pass, see decisions.md.
   *
   * ⚠️ Requires the Reasoning Engine's runtime service agent to have
   * Discovery Engine read access on the project (see
   * ensureReasoningEngineDiscoveryAccess below) — without it, the deployed
   * agent 403s at query time even though deployment itself succeeds.
   */
  groundingDataStores?: string[];
  /**
   * Live third-party action connectors (Track B). Each entry becomes a REAL
   * Python function tool inside the deployed Reasoning Engine that calls the
   * third-party API at inference time — see `_build_live_connector_tool` in
   * scripts/adk_deploy.py.
   *
   * This replaces the earlier "## External Connector Access" instruction-block
   * approach (connectorToolBuilder.ts), which could not work: an LLM handed a
   * base URL and a bearer token in its prompt has no way to make an HTTP
   * request, so it could only narrate a curl command or hallucinate a response.
   * It was also unsafe — anything in the instruction can be extracted by asking
   * the agent to repeat its prompt.
   *
   * `secretIds` maps a credential field name to its Secret Manager secret id;
   * the container resolves them per call, so nothing secret is pickled into the
   * deployment and a rotated token needs no redeploy.
   *
   * ⚠️ Requires the Reasoning Engine runtime service agent to hold
   * roles/secretmanager.secretAccessor on the project, or every tool call 403s
   * at inference time while deployment still reports success.
   */
  liveConnectors?: Array<{
    id: string;
    /** 'confluence' gets a purpose-built search tool; anything else gets the generic REST tool. */
    kind: string;
    name?: string;
    secretIds: Record<string, string>;
    /** Registry templates for the generic REST tool, e.g. 'https://{subdomain}.example.com'. */
    baseUrlTemplate?: string;
    authHeaderTemplate?: string;
    /**
     * How the container builds the Authorization header: 'bearer' (stored value is the
     * token), 'basic-userpass' (it base64s the pair itself), or one of the token-minting
     * kinds — 'oauth2-client-credentials', 'oauth2-refresh-token',
     * 'google-service-account'. The minting kinds exist because customers can supply
     * durable app credentials but not an access token: those are produced by the
     * exchange and expire within about an hour.
     */
    authKind?: string;
    tokenUrlTemplate?: string;
    scope?: string;
    basicUserField?: string;
    basicSecretField?: string;
    /**
     * For SharePoint/OneDrive: the exact folder or site URL the SOURCE agent named as
     * its knowledge source. The deployed tools are confined to this path.
     *
     * Scope matters more than it looks: an app credential with Sites.Read.All can read
     * every site in the tenant (99 in the test tenant), while the Copilot agent it came
     * from pointed at ONE folder. Confining the tool is a real guarantee; asking the
     * model nicely in an instruction is not.
     */
    scopeUri?: string;
  }>;
  /**
   * Migrated Copilot topics, deployed as ADK sub-agents INSIDE this one Reasoning
   * Engine — not as separate deployments. A Copilot agent with six topic domains would
   * otherwise cost six engines and exhaust the ~7/day agent-creation quota on a single
   * migration.
   *
   * `description` is what the root agent routes on, so it must describe WHEN to use the
   * sub-agent, not merely restate its name.
   */
  subAgents?: Array<{
    id: string;
    displayName?: string;
    description?: string;
    instruction: string;
    model?: string;
    /** Sub-agents share the root's tools unless this is false. */
    inheritTools?: boolean;
  }>;
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
  const baseInstruction = opts?.instruction ?? ir.instructions ?? '';
  return {
    name: sanitize(ir.name),
    displayName: ir.name,                                              // Stage 1 ✓
    description: ir.description || `Migrated from Copilot Studio: ${ir.name}`, // Stage 1 ✓
    model: opts?.model || 'gemini-2.5-flash',
    instruction: withKnowledgeResponseRules(baseInstruction, (opts?.groundingDataStores?.length ?? 0) > 0),
    tools,                                                            // only googleSearch for now (Stage 3 adds the rest)
    groundingDataStores: opts?.groundingDataStores?.length ? opts.groundingDataStores : undefined,
  };
}

/**
 * Append the response rules a grounded agent needs, leaving the migrated instruction
 * itself untouched above them.
 *
 * Two behaviours this fixes, both observed live 2026-08-07 on a migrated agent:
 *   - it narrated its own plumbing — "I access these through my
 *     search_knowledge_source_1 and search_knowledge_source_2 functions";
 *   - it answered from a single source without citing anything, so a reader could not
 *     tell what was retrieved from what was invented.
 *
 * The `Sources:` contract is the one proven in the hand-built cited agent
 * (spikes/_e2e_adk_cited_agent.ts), which is why migrated agents looked worse than
 * the demo agent: that instruction existed only in the spike, never in the product.
 *
 * Appended, never merged into the customer's own instruction text — migration fidelity
 * means their words stay verbatim and ours are visibly separate.
 */
function withKnowledgeResponseRules(instruction: string, hasKnowledge: boolean): string {
  if (!hasKnowledge) return instruction;
  const rules = [
    '',
    '---',
    '## How to answer (added by migration)',
    '',
    'Search your knowledge sources before answering questions about their subject matter.',
    'When more than one source could hold the answer, search each relevant one rather than',
    'repeating the same search.',
    '',
    'Never mention tool or function names, data store ids, or that you performed a search.',
    'These are internal. Describe what you know, not how you retrieved it.',
    '',
    'When you used retrieved information, end the reply with a "Sources:" section, one line',
    'per source:',
    '  - [INDEXED] <document or page title>',
    '  - [LIVE] <title> — <url>',
    'Use [LIVE] only for results from a live connector tool, including the url it returned.',
    'Use [INDEXED] for results from a knowledge source search.',
    '',
    'If a search returns nothing, say plainly that you could not find it in your knowledge',
    'sources. Do not answer from general knowledge and present it as if it came from them.',
  ].join('\n');
  return `${instruction.trimEnd()}\n${rules}\n`;
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
/** Resolve a project id to its numeric project number (cached per process). */
const projectNumberCache = new Map<string, string>();
async function resolveProjectNumber(project: string, saToken: string): Promise<string | null> {
  const cached = projectNumberCache.get(project);
  if (cached) return cached;
  const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (!res.ok) {
    logger.warn({ project, status: res.status }, 'adk: could not resolve project number for RE service agent');
    return null;
  }
  const json = (await res.json()) as { projectNumber?: string };
  if (!json.projectNumber) return null;
  projectNumberCache.set(project, json.projectNumber);
  return json.projectNumber;
}

export async function ensureReasoningEngineDiscoveryAccess(
  project: string,
  saToken: string,
): Promise<{ ok: boolean; alreadyGranted?: boolean; error?: string }> {
  // The service agent is keyed by project NUMBER, not project id. Using the id
  // produced `400 Service account service-<projectId>@gcp-sa-aiplatform-re...
  // does not exist` on every call, so the grant silently never applied and every
  // grounded ADK agent 403d at query time on any project that had not been
  // granted by hand (verified live 2026-08-06).
  const projectNumber = await resolveProjectNumber(project, saToken);
  if (!projectNumber) return { ok: false, error: `could not resolve project number for ${project}` };
  const serviceAgent = `service-${projectNumber}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`;
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
  /** The worker refused to wire googleSearch because it cannot coexist with the
   *  function tools this agent has. Reported so it becomes a fidelity note. */
  droppedGoogleSearch?: boolean;
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
        const j = JSON.parse(line) as { reasoningEngine?: string; error?: string; droppedGoogleSearch?: boolean };
        if (j.reasoningEngine) {
          return resolve({ ok: true, reasoningEngine: j.reasoningEngine, droppedGoogleSearch: j.droppedGoogleSearch });
        }
        return resolve({ ok: false, error: j.error || `deploy failed (exit ${code}): ${err.slice(-300)}` });
      } catch {
        return resolve({ ok: false, error: `deploy produced no JSON result (exit ${code}): ${(err || out).slice(-300)}` });
      }
    });
  });
}

/**
 * Delete a deployed Reasoning Engine. Used to clean up after a failed registration —
 * an engine nothing points at still runs and still bills.
 * `force=true` also removes the sessions it accumulated.
 */
async function deleteReasoningEngine(location: string, resourceName: string): Promise<boolean> {
  try {
    const { GoogleAuth } = await import('google-auth-library');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
    const token = await auth.getAccessToken();
    const res = await fetch(
      `https://${location}-aiplatform.googleapis.com/v1beta1/${resourceName}?force=true`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
    );
    return res.ok || res.status === 404;
  } catch (err) {
    logger.warn({ resourceName, err: (err as Error).message }, 'adk: reasoning engine cleanup failed');
    return false;
  }
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
    /** Configured third-party connectors to wire as LIVE API tools on this agent
     *  (see AdkSpec.liveConnectors). Built by
     *  connectorToolBuilder.buildLiveConnectorSpecs from the customer's saved
     *  connectors — secret ids only, resolved in-container per call. */
    liveConnectors?: AdkSpec['liveConnectors'];
    /** Migrated topics as in-deployment sub-agents (see AdkSpec.subAgents). */
    subAgents?: AdkSpec['subAgents'];
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
  // Web browsing is also dropped when the agent has live connector tools or sub-agents,
  // because Gemini refuses a built-in search tool alongside function tools. That case is
  // decided inside the worker (it knows the final tool list), so the flag is OR'd with
  // what the worker reports back rather than guessed twice in two places.
  let googleSearchDropped = groundingDataStores.length > 0 && !!ir.capabilities?.webBrowsing;

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
  if (opts?.liveConnectors?.length) spec.liveConnectors = opts.liveConnectors;
  if (opts?.subAgents?.length) spec.subAgents = opts.subAgents;
  logger.info({ agent: ir.name, location }, 'adk: deploying reasoning engine');
  const dep = await deployReasoningEngine(dest.project, location, spec, { stagingBucket: opts?.stagingBucket });
  if (!dep.ok || !dep.reasoningEngine) return { ok: false, error: `deploy: ${dep.error}` };
  if (dep.droppedGoogleSearch) googleSearchDropped = true;
  logger.info({ agent: ir.name, reasoningEngine: dep.reasoningEngine }, 'adk: registering into engine');
  const reg = await registerAdkAgent(dest, saToken, {
    reasoningEngine: dep.reasoningEngine,
    displayName: spec.displayName,
    description: spec.description,
  });
  if (!reg.registered) {
    // Deploy succeeded, registration did not — delete the Reasoning Engine.
    //
    // Otherwise every failed migration leaves an always-on, billable engine attached to
    // nothing. Seen live 2026-08-07: resolveDestination picked an engine with no
    // assistant, registration 404'd, and the deployed engine had to be deleted by hand.
    // Best-effort: if the delete fails we still report the register error, and say the
    // engine was left behind so someone can remove it.
    const cleanup = await deleteReasoningEngine(location, dep.reasoningEngine);
    logger.warn(
      { agent: ir.name, reasoningEngine: dep.reasoningEngine, cleaned: cleanup },
      'adk: registration failed — deployed reasoning engine ' + (cleanup ? 'deleted' : 'COULD NOT be deleted (still billable)'),
    );
    return {
      ok: false,
      reasoningEngine: dep.reasoningEngine,
      error: `register: ${reg.error}${cleanup ? '' : ' (WARNING: the deployed Reasoning Engine could not be deleted and is still billable)'}`,
      groundingIamGranted,
      groundingIamError,
      googleSearchDropped,
    };
  }
  return { ok: true, agentId: reg.agentId, reasoningEngine: dep.reasoningEngine, state: reg.state, groundingIamGranted, groundingIamError, googleSearchDropped };
}
