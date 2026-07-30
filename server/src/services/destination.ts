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
 *  a 403/error (admin can't see that project's engines) just means "not a target". */
async function projectHasEngine(projectNumber: string, userToken: string): Promise<boolean> {
  try {
    const res = await fetch(
      `https://discoveryengine.googleapis.com/v1alpha/projects/${projectNumber}` +
        `/locations/${LOCATION}/collections/default_collection/engines`,
      { headers: { Authorization: `Bearer ${userToken}` } },
    );
    if (!res.ok) return false;
    const engines = ((await res.json()) as { engines?: unknown[] }).engines ?? [];
    return engines.length > 0;
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
export async function listProjects(userToken: string | undefined): Promise<ProjectRef[]> {
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
      mapPoolCollect(active, PROBE_CONCURRENCY, (p) => projectHasEngine(p.projectNumber, userToken)),
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

/**
 * List Agentspace engines (apps) in a project — the destinations a customer maps
 * their Copilot environments onto. Uses the service-account token.
 */
export async function listEngines(project: string, saToken: string): Promise<EngineRef[]> {
  const url =
    `https://discoveryengine.googleapis.com/v1alpha/projects/${project}` +
    `/locations/${LOCATION}/collections/default_collection/engines`;
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
    if (!res.ok) {
      logger.warn(`listEngines(${project}) failed (${res.status})`);
      return [];
    }
    const json = (await res.json()) as {
      engines?: { name: string; displayName?: string; solutionType?: string }[];
    };
    return (json.engines ?? []).map((e) => ({
      id: e.name.split('/').pop() ?? '',
      displayName: e.displayName ?? e.name.split('/').pop() ?? '',
      solutionType: e.solutionType,
    }));
  } catch (err) {
    logger.warn({ err, project }, 'listEngines errored');
    return [];
  }
}
