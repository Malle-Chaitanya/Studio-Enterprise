import { logger } from '../logger.js';

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

export interface ProjectRef {
  projectId: string;
  projectNumber: string;
  displayName: string;
}

export interface EngineRef {
  /** Engine id (last path segment) — used as GeminiDestination.engine. */
  id: string;
  displayName: string;
  solutionType?: string;
}

/**
 * List Google Cloud projects the admin can access (OAuth token required).
 * Returns [] when no user token is available — the UI then falls back to
 * manual project-id entry.
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
    const json = (await res.json()) as {
      projects?: { projectId?: string; projectNumber?: string; name?: string; lifecycleState?: string }[];
    };
    return (json.projects ?? [])
      .filter((p) => p.lifecycleState === 'ACTIVE' && p.projectNumber)
      .map((p) => ({
        projectId: p.projectId ?? p.projectNumber!,
        projectNumber: p.projectNumber!,
        displayName: p.name ?? p.projectId ?? p.projectNumber!,
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
