import { logger } from '../logger.js';
import { mapPoolCollect } from '../concurrency.js';

/**
 * Destination discovery for Gemini Enterprise.
 *
 * V1 policy (production): we DISCOVER existing resources and let the customer
 * map to them. We do NOT auto-create projects or engines — that involves
 * billing/IAM/quota lifecycle the customer's cloud team owns. A "create" path
 * can be added later once fully validated.
 *
 *   Projects — discovered via Cloud Resource Manager using the admin's OAuth
 *              token when available; otherwise the customer enters a project id.
 *   Engines  — discovered via Discovery Engine using the service-account token
 *              (the same identity that performs the migration writes).
 */

const LOCATION = 'global';

/** Probes to run at once when enriching the project list. Bounded (quota-safe). */
const PROBE_CONCURRENCY = 8;

export interface ProjectRef {
  projectId: string;
  projectNumber: string;
  displayName: string;
  /** Verified Workspace org domain (e.g. "acme.com"), when the project sits under
   *  an organization we can resolve. Undefined for no-org / folder projects. */
  org?: string;
  /** True when the project already contains a Discovery Engine (Gemini) app — the
   *  only projects that are valid migration destinations under V1 policy. */
  hasGeminiApp: boolean;
}

export interface EngineRef {
  /** Engine id (last path segment) — used as GeminiDestination.engine. */
  id: string;
  displayName: string;
  solutionType?: string;
}

interface RawProject {
  projectId?: string;
  projectNumber?: string;
  name?: string;
  lifecycleState?: string;
  parent?: { type?: string; id?: string };
}

/** Does this project already have a Discovery Engine (Gemini) app? Best-effort —
 *  a 403/error (admin can't see that project's engines) just means "not a target".
 *
 *  PREFERS the service-account token (the same identity that performs the migration
 *  writes) — this file's own module docstring has always said engines are discovered
 *  this way, but the code only ever used the admin's OAuth token, a real drift between
 *  documented design and behaviour (caught 2026-10-26, confirmed against a live tenant:
 *  the OAuth-only version reported zero engines on a project that genuinely has one).
 *  Falls back to the OAuth token when no SA token is available/working — e.g. the admin's
 *  own project, which the SA was never granted or delegated for, but the signed-in admin
 *  can see directly; matches the same SA-then-OAuth order the /engines route already uses. */
async function projectHasEngine(projectNumber: string, userToken: string, saToken?: string): Promise<boolean> {
  // `X-Goog-User-Project` MUST be set on every call here: a plain OAuth/SA token with no
  // quota project header gets billed against the project that owns THIS APP'S OWN OAuth
  // client, not the project being probed — confirmed live 2026-10-26 (see
  // auth/google.ts's discoverGeminiProject, found and fixed there first). Without this,
  // every customer's project list silently shows "no Gemini app" the moment CloudFuze's
  // own project has any billing hiccup, regardless of the customer's own project being
  // perfectly healthy.
  const probe = async (token: string): Promise<boolean> => {
    const res = await fetch(
      `https://discoveryengine.googleapis.com/v1alpha/projects/${projectNumber}` +
        `/locations/${LOCATION}/collections/default_collection/engines`,
      { headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': projectNumber } },
    );
    if (!res.ok) return false;
    const engines = ((await res.json()) as { engines?: unknown[] }).engines ?? [];
    return engines.length > 0;
  };
  if (saToken) {
    try {
      if (await probe(saToken)) return true;
    } catch {
      /* fall through to the OAuth attempt below */
    }
  }
  try {
    return await probe(userToken);
  } catch {
    return false;
  }
}

/** Resolve org ids → verified domain names (best-effort; skips ones we can't read). */
async function resolveOrgDomains(orgIds: string[], userToken: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  await mapPoolCollect(orgIds, PROBE_CONCURRENCY, async (id) => {
    try {
      const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/organizations/${id}`, {
        headers: { Authorization: `Bearer ${userToken}` },
      });
      if (!res.ok) return;
      const org = (await res.json()) as { displayName?: string };
      if (org.displayName) map.set(id, org.displayName);
    } catch {
      /* best-effort: leave unresolved */
    }
  });
  return map;
}

/**
 * List Google Cloud projects the admin can access (OAuth token required),
 * annotated with the project's org and whether it already has a Gemini app.
 *
 * The account may be able to see dozens of projects (auto-created AI-Studio ones
 * etc.); only projects that already contain a Discovery Engine app are valid
 * destinations under V1 policy, so we mark each with `hasGeminiApp` and let the UI
 * show just those by default (with a "show all" escape hatch). Engine probes and
 * org lookups run bounded-parallel — one sequential pass here was the slow bit.
 * Returns [] when no user token is available — the UI then falls back to manual entry.
 */
export async function listProjects(userToken: string | undefined, saToken?: string): Promise<ProjectRef[]> {
  if (!userToken) return [];
  try {
    const res = await fetch('https://cloudresourcemanager.googleapis.com/v1/projects', {
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (!res.ok) {
      logger.warn(`listProjects failed (${res.status}) — falling back to manual entry`);
      return [];
    }
    const json = (await res.json()) as { projects?: RawProject[] };
    const active = (json.projects ?? []).filter(
      (p): p is RawProject & { projectNumber: string } =>
        p.lifecycleState === 'ACTIVE' && Boolean(p.projectNumber),
    );

    // Probe engines + resolve org domains concurrently (bounded).
    const orgIds = [
      ...new Set(active.filter((p) => p.parent?.type === 'organization' && p.parent.id).map((p) => p.parent!.id!)),
    ];
    const [hasEngine, orgDomains] = await Promise.all([
      mapPoolCollect(active, PROBE_CONCURRENCY, (p) => projectHasEngine(p.projectNumber, userToken, saToken)),
      resolveOrgDomains(orgIds, userToken),
    ]);

    return active.map((p, i) => ({
      projectId: p.projectId ?? p.projectNumber,
      projectNumber: p.projectNumber,
      displayName: p.name ?? p.projectId ?? p.projectNumber,
      org: p.parent?.type === 'organization' ? orgDomains.get(p.parent.id ?? '') : undefined,
      hasGeminiApp: hasEngine[i],
    }));
  } catch (err) {
    logger.warn({ err }, 'listProjects errored — falling back to manual entry');
    return [];
  }
}

export interface ListEnginesResult {
  engines: EngineRef[];
  /** HTTP status from Discovery Engine, when a response was received. */
  status?: number;
  /** Set when the call failed or returned non-OK — never silently treated as "no apps". */
  error?: string;
}

/**
 * List Agentspace engines (apps) in a project. Returns engines + honest error
 * info (callers used to swallow 403 as "no apps", which hid SA/IAM failures).
 */
export async function listEnginesResult(project: string, token: string): Promise<ListEnginesResult> {
  const url =
    `https://discoveryengine.googleapis.com/v1alpha/projects/${project}` +
    `/locations/${LOCATION}/collections/default_collection/engines`;
  try {
    // `X-Goog-User-Project` set to the project being queried — see projectHasEngine's
    // comment above for why. Harmless and correct for the SA-token call site too (it is
    // already querying this exact project), and protects the OAuth fallback call site
    // from the same billing-misattribution bug.
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, 'X-Goog-User-Project': project },
    });
    if (!res.ok) {
      let detail = '';
      try {
        const body = (await res.json()) as { error?: { message?: string } };
        detail = body?.error?.message ?? '';
      } catch {
        /* ignore */
      }
      const error = `listEngines(${project}) failed (${res.status})${detail ? `: ${detail}` : ''}`;
      logger.warn(error);
      return { engines: [], status: res.status, error };
    }
    const json = (await res.json()) as {
      engines?: { name: string; displayName?: string; solutionType?: string }[];
    };
    return {
      engines: (json.engines ?? []).map((e) => ({
        id: e.name.split('/').pop() ?? '',
        displayName: e.displayName ?? e.name.split('/').pop() ?? '',
        solutionType: e.solutionType,
      })),
      status: res.status,
    };
  } catch (err) {
    const error = `listEngines(${project}) errored: ${(err as Error).message}`;
    logger.warn({ err, project }, error);
    return { engines: [], error };
  }
}

/** Convenience wrapper — empty array on failure (legacy call sites). Prefer listEnginesResult. */
export async function listEngines(project: string, token: string): Promise<EngineRef[]> {
  return (await listEnginesResult(project, token)).engines;
}
