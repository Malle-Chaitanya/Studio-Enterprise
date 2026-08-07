import { logger } from '../logger.js';
import { geminiWriteLimiter } from './rateLimiter.js';
import type { GeminiDestination, MappedAgent } from '../types.js';

/**
 * Gemini Enterprise (Discovery Engine v1alpha) agent operations.
 * Ports the proven POC calls and adds quota-aware retry/backoff.
 *
 * Every call is parameterized by a GeminiDestination {project, engine,
 * assistant} — nothing about the target hierarchy is hardcoded, so each source
 * environment can be routed to its own engine.
 */

const LOCATION = 'global';

/** Assistants collection base for a destination (engine level). */
export function assistantBase(d: GeminiDestination): string {
  return (
    `https://discoveryengine.googleapis.com/v1alpha/projects/${d.project}` +
    `/locations/${LOCATION}/collections/default_collection/engines/${d.engine}` +
    `/assistants/${d.assistant}`
  );
}

/** Agents collection base for a destination. */
function agentBase(d: GeminiDestination): string {
  return `${assistantBase(d)}/agents`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * POST/PATCH/etc. with resilient backoff on 429/503:
 *  - honors the server's `Retry-After` header when present (don't guess),
 *  - equal-jitter otherwise (base/2 + random(0, base/2)) so parallel callers
 *    don't retry in lockstep and re-collide (the "thundering herd"),
 *  - capped exponential growth with generous retries for enterprise-scale runs.
 */
async function withBackoff(
  fn: () => Promise<Response>,
  { retries = 6, baseMs = 1000, maxMs = 30000 } = {},
): Promise<Response> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await geminiWriteLimiter.acquire(); // pace writes to avoid 429 bursts
    const res = await fn();
    if (res.status !== 429 && res.status !== 503) return res;
    // HARD quota (RESOURCE_EXHAUSTED, e.g. "Agent creation quota exceeded") is
    // license/seat-based — retrying within a run can't succeed. Fail fast so the
    // caller surfaces an actionable message instead of a 90s backoff grind.
    if (res.status === 429) {
      const body = await res.clone().text().catch(() => '');
      if (/RESOURCE_EXHAUSTED|quota exceeded/i.test(body)) {
        logger.warn('Gemini HARD quota (RESOURCE_EXHAUSTED) — not retrying; needs a quota/seat increase');
        return res;
      }
    }
    if (attempt >= retries) return res;
    const retryAfter = res.headers.get('retry-after');
    let base: number;
    if (retryAfter) {
      const secs = Number(retryAfter);
      base = Number.isFinite(secs) ? secs * 1000 : Math.max(0, new Date(retryAfter).getTime() - Date.now());
    } else {
      base = Math.min(maxMs, baseMs * 2 ** attempt);
    }
    const wait = Math.round(base / 2 + Math.random() * (base / 2)); // equal jitter
    logger.warn({ status: res.status, attempt, wait, retryAfter: retryAfter ?? undefined }, 'Gemini rate limited; backing off');
    await sleep(wait);
    attempt++;
  }
}

function buildCreateBody(agent: MappedAgent) {
  const hasDataStores = (agent.groundingDataStores?.length ?? 0) > 0;

  const llmAgentNode: Record<string, unknown> = {
    description: agent.description,
    model: agent.model,
    instruction: agent.instruction,
    subAgentIds: [],
  };

  if (hasDataStores) {
    // Native data store grounding via dataStoreSpecs — bypasses RE entirely.
    // Learned from inspecting a console-created connector agent: the console
    // uses dataStoreSpecs.specs (not selectedTools.tool) for knowledge grounding.
    llmAgentNode['dataStoreSpecs'] = {
      specs: agent.groundingDataStores!.map((ds) => ({ dataStore: ds })),
    };
    llmAgentNode['selectedTools'] = { tool: [{ name: 'googleSearch' }] };
  } else {
    llmAgentNode['selectedTools'] = { tool: agent.tools };
  }

  const rootNode = {
    id: 'root_agent',
    displayName: agent.displayName,
    llmAgentNode,
  };

  return {
    displayName: agent.displayName,
    description: agent.description,
    starterPrompts: agent.starterPrompts,
    icon: {},
    lowCodeAgentDefinition: {
      rootAgentId: 'root_agent',
      nodes: [rootNode],
      // Pre-populate deployedNodes (same as nodes) — mirrors what the console does.
      // Agents created this way are PRIVATE (creator-accessible draft) and require
      // a manual Publish click in the Agentspace console for org-wide ENABLED state.
      deployedNodes: [rootNode],
      deployedRootAgentId: 'root_agent',
      draftDisplayName: agent.displayName,
      draftDescription: agent.description,
      draftStarterPrompts: agent.starterPrompts.slice(0, 2),
      draftIcon: { content: '' },
      agentFiles: [],
      draftSchedules: [],
      deployedSchedules: [],
    },
  };
}

export interface CreateOutcome {
  created: boolean;
  agentId?: string;
  /** PRIVATE | ENABLED — low-code agents can come back PRIVATE and never move
   *  (see adkDeployer.ts); callers use this to decide whether to fall back. */
  state?: string;
  alreadyExists?: boolean;
  error?: string;
}

export async function createAgent(
  dest: GeminiDestination,
  saToken: string,
  agent: MappedAgent,
): Promise<CreateOutcome> {
  const res = await withBackoff(() =>
    fetch(agentBase(dest), {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildCreateBody(agent)),
    }),
  );

  if (res.ok) {
    const json = (await res.json()) as { name?: string; state?: string };
    const agentId = json.name?.split('/').pop();
    return { created: true, agentId, state: json.state };
  }
  const text = await res.text();
  if (text.includes('already exists')) return { created: false, alreadyExists: true };
  return { created: false, error: `${res.status}: ${text.slice(0, 160)}` };
}

export async function publishAgent(dest: GeminiDestination, saToken: string, agentId: string): Promise<boolean> {
  const res = await withBackoff(() =>
    fetch(`${agentBase(dest)}/${agentId}:publish`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    }),
  );
  return res.ok;
}

export async function shareAgent(dest: GeminiDestination, saToken: string, agentId: string): Promise<boolean> {
  const res = await withBackoff(() =>
    fetch(`${agentBase(dest)}/${agentId}?updateMask=sharingConfig`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
    }),
  );
  return res.ok;
}

/**
 * Delete an agent. Used to clean up a stuck-PRIVATE low-code agent once the
 * ADK/Reasoning-Engine fallback has successfully replaced it — without this,
 * a fallback leaves TWO agent resources at the destination for one source
 * agent (wasted quota + a confusing duplicate an admin has to notice and
 * remove by hand). Idempotent: 404 (already gone) counts as success.
 */
export async function deleteAgent(dest: GeminiDestination, saToken: string, agentId: string): Promise<{ ok: boolean; error?: string }> {
  const res = await withBackoff(() =>
    fetch(`${agentBase(dest)}/${agentId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${saToken}` },
    }),
  );
  if (res.ok || res.status === 404) return { ok: true };
  return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
}

/** Confirm an engine is reachable (used during connect + before routing to it). */
export async function engineReachable(dest: GeminiDestination, saToken: string): Promise<boolean> {
  try {
    const res = await fetch(agentBase(dest), {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Default destination for a project. Engine/assistant default to the standard
 * Agentspace names but are env-overridable (GEMINI_ENGINE / GEMINI_ASSISTANT) so
 * you can point the tool at a different, properly-licensed project + engine
 * without code changes.
 */
export function defaultDestination(project: string): GeminiDestination {
  return {
    project,
    engine: process.env.GEMINI_ENGINE || 'agentspace-engine',
    assistant: process.env.GEMINI_ASSISTANT || 'default_assistant',
  };
}

export interface EngineInfo {
  id: string;
  displayName?: string;
  solutionType?: string;
  dataStoreIds?: string[];
}

/** True if the token can read the project's engines (i.e. has access). */
export async function projectReachable(project: string, token: string): Promise<boolean> {
  const url =
    `https://discoveryengine.googleapis.com/v1alpha/projects/${project}` +
    `/locations/${LOCATION}/collections/default_collection/engines`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    return res.ok;
  } catch {
    return false;
  }
}

/** List the engines (Agentspace/AI-Applications apps) in a project. */
export async function discoverEngines(project: string, saToken: string): Promise<EngineInfo[]> {
  const url =
    `https://discoveryengine.googleapis.com/v1alpha/projects/${project}` +
    `/locations/${LOCATION}/collections/default_collection/engines`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
    if (!res.ok) return [];
    const engines = ((await res.json()) as { engines?: Record<string, unknown>[] }).engines ?? [];
    return engines.map((e) => ({
      id: String(e.name).split('/').pop() ?? '',
      displayName: e.displayName as string | undefined,
      solutionType: e.solutionType as string | undefined,
      dataStoreIds: e.dataStoreIds as string[] | undefined,
    }));
  } catch {
    return [];
  }
}

/**
 * Resolve the destination for a project — CLIENT-AGNOSTIC. Explicit env
 * (GEMINI_ENGINE) wins; otherwise discover the project's engine(s) and pick one
 * (preferring a chat/assistant-capable app). Falls back to the standard name
 * only if discovery finds nothing. So the tool works against any client's
 * project without hardcoding their engine id.
 */
/**
 * The project we should actually target, applying the GEMINI_PROJECT override.
 *
 * The override has to be applied at every point of USE, not only in
 * discoverGeminiProject. The project is discovered once, at Google connect, and then
 * stored on the session — so an existing session keeps its original project forever
 * and an operator who sets GEMINI_PROJECT sees no effect until they start a brand new
 * session. That is exactly how a run on 2026-08-07 went to the old project again
 * minutes after the override was configured.
 *
 * It matters for CREDENTIALS as much as for the agent: secrets written to one project
 * cannot be read by an agent deployed in another, so a half-applied override is worse
 * than none — it deploys to the right place and stores the credentials in the wrong one.
 */
export function effectiveGeminiProject(project: string | undefined): string {
  const forced = (process.env.GEMINI_PROJECT ?? '').trim();
  return forced || project || '';
}

export async function resolveDestination(project: string, saToken: string): Promise<GeminiDestination> {
  const assistant = process.env.GEMINI_ASSISTANT || 'default_assistant';

  const effective = effectiveGeminiProject(project);
  if (effective !== project) {
    logger.info({ from: project, to: effective }, 'resolveDestination: project overridden by GEMINI_PROJECT');
    project = effective;
  }
  if (process.env.GEMINI_ENGINE) {
    return { project, engine: process.env.GEMINI_ENGINE, assistant };
  }
  const engines = await discoverEngines(project, saToken);

  // Order by likelihood, then VERIFY. solutionType alone is not enough to tell which
  // engine can host agents: a project can hold several SOLUTION_TYPE_SEARCH engines and
  // only one of them has an assistant. Picking by heuristic sent a real migration to
  // `cf-knowledge-search`, whose assistants endpoint 404s — the Reasoning Engine deployed
  // (and billed) and then registration failed, taking the low-code fallback down with it
  // since it targets the same engine. Verified live 2026-08-07.
  const ordered = [
    ...engines.filter((e) => /CHAT|ASSISTANT/i.test(e.solutionType ?? '')),
    ...engines.filter((e) => /SEARCH/i.test(e.solutionType ?? '')),
    ...engines,
  ].filter((e, i, arr) => arr.findIndex((x) => x.id === e.id) === i);

  for (const candidate of ordered) {
    if (await assistantExists(project, saToken, candidate.id, assistant)) {
      return { project, engine: candidate.id, assistant };
    }
  }

  // Nothing verified — fall back to the old heuristic rather than failing outright, so a
  // transient probe error does not block a migration. The caller still surfaces the
  // register error honestly if this guess is wrong.
  logger.warn(
    { project, engines: ordered.map((e) => e.id) },
    'resolveDestination: no engine exposed an assistant; falling back to the first candidate',
  );
  return { project, engine: ordered[0]?.id || 'agentspace-engine', assistant };
}

/**
 * Does this engine actually expose the assistant agents are registered under?
 * Cached per process: resolveDestination runs per agent in a migration.
 */
const assistantProbeCache = new Map<string, boolean>();
async function assistantExists(
  project: string,
  saToken: string,
  engine: string,
  assistant: string,
): Promise<boolean> {
  const key = `${project}/${engine}/${assistant}`;
  const cached = assistantProbeCache.get(key);
  if (cached !== undefined) return cached;
  try {
    const res = await fetch(
      `https://discoveryengine.googleapis.com/v1alpha/projects/${project}` +
        `/locations/${LOCATION}/collections/default_collection` +
        `/engines/${engine}/assistants/${assistant}`,
      { headers: { Authorization: `Bearer ${saToken}` } },
    );
    const ok = res.ok;
    assistantProbeCache.set(key, ok);
    return ok;
  } catch {
    return false;
  }
}
