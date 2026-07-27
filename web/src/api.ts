import type {
  AgentAssessment,
  AgentBrief,
  EnvironmentInfo,
  MigrationScope,
  PlanPreview,
  SessionSummary,
} from './types.ts';

export async function fetchSession(id: string): Promise<SessionSummary> {
  const res = await fetch(`/api/auth/session/${id}`);
  if (!res.ok) throw new Error('session_not_found');
  return (await res.json()) as SessionSummary;
}

export async function disconnectPlatform(
  session: string,
  platform: 'microsoft' | 'google',
): Promise<{ ok: boolean; sessionEnded?: boolean }> {
  const res = await fetch('/api/auth/disconnect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, platform }),
  });
  if (!res.ok) throw new Error('disconnect_failed');
  return (await res.json()) as { ok: boolean; sessionEnded?: boolean };
}

/** Resume the last connected session (cloud connections persist across logout). */
export async function resumeSession(): Promise<string | null> {
  try {
    const res = await fetch('/api/auth/resume');
    if (!res.ok) return null;
    return ((await res.json()) as { session: string | null }).session;
  } catch {
    return null;
  }
}

export const microsoftStartUrl = () => '/api/auth/microsoft/start';
export const googleStartUrl = (session: string) => `/api/auth/google/start?session=${session}`;

/**
 * Open an OAuth flow in a POPUP and resolve when it posts the result back to the
 * opener (GEM_CO-style) — the main app never navigates away. Resolves on the
 * success/error postMessage, or on the popup being closed manually (so a
 * cancelled connect doesn't hang the caller).
 */
export function connectViaPopup(
  startUrl: string,
  successType: string,
  errorType: string,
): Promise<{ ok: boolean; session?: string; error?: string }> {
  return new Promise((resolve) => {
    const url = `${startUrl}${startUrl.includes('?') ? '&' : '?'}popup=1`;
    const popup = window.open(url, 'cfconnect', 'width=520,height=720,left=280,top=80');
    let settled = false;
    const finish = (r: { ok: boolean; session?: string; error?: string }): void => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMsg);
      clearInterval(closeCheck);
      resolve(r);
    };
    const onMsg = (e: MessageEvent): void => {
      const d = e.data as { type?: string; session?: string; error?: string } | null;
      if (!d || typeof d.type !== 'string') return;
      if (d.type === successType) finish({ ok: true, session: d.session });
      else if (d.type === errorType) finish({ ok: false, error: d.error });
    };
    window.addEventListener('message', onMsg);
    const closeCheck = setInterval(() => {
      if (popup && popup.closed) finish({ ok: false, error: 'closed' });
    }, 500);
  });
}
export const migrateStreamUrl = (session: string) => `/api/migrate/stream?session=${session}`;

export async function fetchEnvironments(session: string): Promise<EnvironmentInfo[]> {
  const res = await fetch(`/api/explore/environments?session=${session}`);
  if (!res.ok) throw new Error('environments_failed');
  return ((await res.json()) as { environments: EnvironmentInfo[] }).environments;
}

export async function fetchAgents(session: string, env: string): Promise<AgentBrief[]> {
  const res = await fetch(`/api/explore/agents?session=${session}&env=${encodeURIComponent(env)}`);
  if (!res.ok) throw new Error('agents_failed');
  return ((await res.json()) as { agents: AgentBrief[] }).agents;
}

export async function fetchAssessment(
  session: string,
  env: string,
  bot: AgentBrief,
): Promise<AgentAssessment> {
  const res = await fetch(
    `/api/explore/agent?session=${session}&env=${encodeURIComponent(env)}&botId=${bot.botid}&name=${encodeURIComponent(bot.name)}`,
  );
  if (!res.ok) throw new Error('assessment_failed');
  return ((await res.json()) as { assessment: AgentAssessment }).assessment;
}

export function agentJsonUrl(session: string, env: string, bot: AgentBrief): string {
  return `/api/explore/agent?session=${session}&env=${encodeURIComponent(env)}&botId=${bot.botid}&name=${encodeURIComponent(bot.name)}&format=json`;
}

export type KnowledgeHandling = 'skip' | 'appendix' | 'report-only';

// ── Destination discovery (production project/engine picker) ─────────────────
export interface DestProject { projectId: string; projectNumber: string; displayName: string }
export interface DestEngine { id: string; displayName: string; solutionType?: string }
export interface GeminiDest { project: string; engine: string; assistant: string }

/** List the Google Cloud projects the connected admin can access. */
export async function fetchProjects(session: string): Promise<{ projects: DestProject[]; manualEntry: boolean }> {
  const res = await fetch(`/api/destination/projects?session=${session}`);
  if (!res.ok) throw new Error('projects_failed');
  return (await res.json()) as { projects: DestProject[]; manualEntry: boolean };
}

/** List the Gemini Enterprise engines (apps) in a chosen project. */
export async function fetchEngines(session: string, project: string): Promise<DestEngine[]> {
  const res = await fetch(`/api/destination/engines?session=${session}&project=${encodeURIComponent(project)}`);
  if (!res.ok) throw new Error('engines_failed');
  return ((await res.json()) as { engines: DestEngine[] }).engines;
}

export async function planMigration(
  session: string,
  scope: MigrationScope,
  destination: {
    prefixWithEnv: boolean;
    projects?: Record<string, string>;
    environmentMap?: Record<string, GeminiDest>;
  },
  dryRun: boolean,
  knowledgeHandling: KnowledgeHandling = 'report-only',
): Promise<PlanPreview> {
  const res = await fetch('/api/migrate/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, scope, destination, dryRun, knowledgeHandling }),
  });
  if (!res.ok) throw new Error('plan_failed');
  return (await res.json()) as PlanPreview;
}
