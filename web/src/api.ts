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

export const microsoftStartUrl = (session?: string) =>
  session ? `/api/auth/microsoft/start?session=${session}` : '/api/auth/microsoft/start';
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

// ── Destination discovery (production project/engine picker) ─────────────────
export interface DestProject {
  projectId: string;
  projectNumber: string;
  displayName: string;
  org?: string;
  hasGeminiApp: boolean;
}
export interface DestEngine { id: string; displayName: string; solutionType?: string }
export interface GeminiDest { project: string; engine: string; assistant: string }

/** List the Google Cloud projects the connected admin can access. `defaultProject`
 *  is the discovered Gemini destination, used to pre-select the dropdown. */
export async function fetchProjects(
  session: string,
): Promise<{ projects: DestProject[]; manualEntry: boolean; defaultProject?: string }> {
  const res = await fetch(`/api/destination/projects?session=${session}`);
  if (!res.ok) throw new Error('projects_failed');
  return (await res.json()) as { projects: DestProject[]; manualEntry: boolean; defaultProject?: string };
}

/** List the Gemini Enterprise engines (apps) in a chosen project. */
export async function fetchEngines(
  session: string,
  project: string,
): Promise<{ engines: DestEngine[]; warning?: string; via?: string }> {
  const res = await fetch(`/api/destination/engines?session=${session}&project=${encodeURIComponent(project)}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string };
    throw new Error(body.detail || 'engines_failed');
  }
  return (await res.json()) as { engines: DestEngine[]; warning?: string; via?: string };
}

// ── SharePoint connector setup (the customer's own Entra app credentials) ────
// One connector per SITE, not per session — a migration can touch several
// distinct SharePoint sites. Credentials are optional on the request: if the
// tenant was already onboarded, CloudFuze reuses the stored Secret Manager
// reference and the admin doesn't have to re-enter anything (see
// .claude/memory/decisions.md, 2026-08-03).
export interface SharePointConnectorCreds {
  siteUrl: string;
  tenantId: string;
  clientId?: string;
  clientSecret?: string;
}
export interface SharePointConnectorStatus {
  status?: 'pending' | 'done' | 'failed';
  collectionId?: string;
  dataStoreIds?: string[];
  error?: string;
  /** The status CHECK ITSELF failed (not a real "still provisioning") — a
   *  distinct signal so a genuine problem never hides behind an endless,
   *  indistinguishable "still provisioning" message. */
  checkError?: string;
}
export interface KnowledgeConnectorSummary {
  kind: 'sharepoint' | 'onedrive';
  siteUrl: string;
  collectionId: string;
  tenantId: string;
  status: 'pending' | 'done' | 'failed';
  error?: string;
  dataStoreIds?: string[];
}

/** Kick off Gemini's native SharePoint connector for one site, using the
 *  customer's own Entra app credentials (never CloudFuze's) — starts a
 *  long-running operation. */
export async function setUpSharePointConnector(
  session: string,
  creds: SharePointConnectorCreds,
): Promise<{ started: boolean; collectionId: string; operationName?: string }> {
  const res = await fetch('/api/destination/sharepoint-connector', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, ...creds }),
  });
  if (!res.ok) {
    // Surface the backend's real reason (e.g. "connector_credentials_required",
    // or Google's own error text via `detail`) — never collapse every failure
    // into one indistinguishable generic message, or a real cause is invisible.
    const body = await res.json().catch(() => ({}) as { error?: string; detail?: string });
    throw new Error(body.detail || body.error || 'connector_setup_failed');
  }
  return (await res.json()) as { started: boolean; collectionId: string; operationName?: string };
}

/** Poll one site's connector-creation operation. `done` means Google finished
 *  provisioning — the orchestrator's insert phase does the actual attach step
 *  and records the real fidelity outcome. */
export async function fetchSharePointConnectorStatus(session: string, siteUrl: string): Promise<SharePointConnectorStatus> {
  const res = await fetch(`/api/destination/sharepoint-connector/status?session=${session}&siteUrl=${encodeURIComponent(siteUrl)}`);
  if (!res.ok) throw new Error('connector_status_failed');
  return (await res.json()) as SharePointConnectorStatus;
}

/** Forget our tracking row for one site's connector so the next setup starts
 *  fresh — for re-testing, or after a customer rotates their Entra secret.
 *  Does NOT delete anything on Google's side. */
export async function removeSharePointConnector(session: string, siteUrl: string): Promise<void> {
  const res = await fetch(`/api/destination/sharepoint-connector?session=${session}&siteUrl=${encodeURIComponent(siteUrl)}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error('connector_remove_failed');
}

/** Every knowledge connector configured for this customer across every site —
 *  powers a batch "N connectors need authorization" view instead of
 *  discovering them one at a time. */
export async function fetchKnowledgeConnectors(session: string): Promise<KnowledgeConnectorSummary[]> {
  const res = await fetch(`/api/destination/connectors?session=${session}`);
  if (!res.ok) throw new Error('connectors_failed');
  return ((await res.json()) as { connectors: KnowledgeConnectorSummary[] }).connectors;
}

/** One site that needs a connector, and every agent (in one environment) that references it. */
export interface ConnectorNeeded {
  siteUrl: string;
  kind: 'sharepoint-connector' | 'onedrive-connector';
  agentNames: string[];
}

/**
 * SharePoint/OneDrive sites that need a connector.
 *
 * `botIds` scopes the scan to the agents the customer selected. Without it the server
 * extracts EVERY agent in the environment — slow, and it surfaces connectors belonging
 * to agents that are not part of this migration.
 */
export async function fetchConnectorsNeeded(
  session: string,
  env: string,
  botIds: string[] = [],
): Promise<ConnectorNeeded[]> {
  const q = botIds.length ? `&botIds=${encodeURIComponent(botIds.join(','))}` : '';
  const res = await fetch(`/api/explore/connectors-needed?session=${session}&env=${encodeURIComponent(env)}${q}`);
  if (!res.ok) throw new Error('connectors_needed_failed');
  return ((await res.json()) as { connectors: ConnectorNeeded[] }).connectors;
}

// ── Identity map (agent-touched principals) ─────────────────────────────────
export interface DiscoveredIdentityPrincipal {
  key: string;
  role: 'owner' | 'editor' | 'viewer' | 'chat-group' | 'org-wide';
  type: 'user' | 'team' | 'group';
  id: string;
  email?: string;
  displayName?: string;
  agentCount: number;
  agentNames: string[];
  geminiSeat: 'unknown' | 'yes' | 'no';
}

export interface IdentityMapPayload {
  tenantId: string;
  users: Record<string, string>;
  groups: Record<string, string>;
}

export async function discoverPrincipals(
  session: string,
  selection: { env: string; botIds: string[]; name?: string }[],
): Promise<{ principals: DiscoveredIdentityPrincipal[]; orgWideAgentsReferenced: number; errors: { env: string; botId: string; error: string }[] }> {
  const res = await fetch('/api/identity/principals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, selection }),
  });
  if (!res.ok) throw new Error('principals_failed');
  return (await res.json()) as {
    principals: DiscoveredIdentityPrincipal[];
    orgWideAgentsReferenced: number;
    errors: { env: string; botId: string; error: string }[];
  };
}

export async function fetchIdentityMap(session: string): Promise<IdentityMapPayload> {
  const res = await fetch(`/api/identity/map?session=${session}`);
  if (!res.ok) throw new Error('identity_map_failed');
  return (await res.json()) as IdentityMapPayload;
}

export async function saveIdentityMap(
  session: string,
  users: Record<string, string>,
  groups: Record<string, string>,
): Promise<IdentityMapPayload> {
  const res = await fetch('/api/identity/map', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, users, groups }),
  });
  if (!res.ok) throw new Error('identity_map_save_failed');
  return (await res.json()) as IdentityMapPayload;
}

export async function suggestIdentityMap(
  session: string,
  principals: { type: string; id: string; email?: string; displayName?: string }[],
): Promise<{ ownedDomains: string[]; suggested: { users: Record<string, string>; groups: Record<string, string> } }> {
  const res = await fetch('/api/identity/suggest', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, principals }),
  });
  if (!res.ok) throw new Error('identity_suggest_failed');
  return (await res.json()) as {
    ownedDomains: string[];
    suggested: { users: Record<string, string>; groups: Record<string, string> };
  };
}

export async function fetchGoogleUsers(
  session: string,
  opts?: { q?: string; max?: number },
): Promise<{ users: { email: string; displayName?: string; suspended?: boolean }[]; error?: string }> {
  const qs = new URLSearchParams({ session });
  if (opts?.q) qs.set('q', opts.q);
  if (opts?.max) qs.set('max', String(opts.max));
  const res = await fetch(`/api/identity/google-users?${qs}`);
  if (!res.ok) throw new Error('google_users_failed');
  return (await res.json()) as { users: { email: string; displayName?: string; suspended?: boolean }[]; error?: string };
}

export interface MsUserBrief {
  id: string;
  email: string;
  displayName?: string;
  userPrincipalName?: string;
  accountEnabled?: boolean;
}

/** Microsoft Graph users for the Map Users grid. */
export async function fetchMsUsers(
  session: string,
  opts?: { q?: string; max?: number },
): Promise<MsUserBrief[]> {
  const qs = new URLSearchParams({ session });
  if (opts?.q) qs.set('q', opts.q);
  if (opts?.max) qs.set('max', String(opts.max));
  const res = await fetch(`/api/identity/ms-users?${qs}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { detail?: string; error?: string };
    throw new Error(body.detail || body.error || 'ms_users_failed');
  }
  return ((await res.json()) as { users: MsUserBrief[] }).users;
}

// ── SharePoint/OneDrive knowledge source: search-and-confirm ────────────────
export interface KnowledgeCandidate {
  driveId: string;
  itemId: string;
  name: string;
  sizeBytes?: number;
  webUrl?: string;
  lastModifiedDateTime?: string;
  parentContext?: string;
}
export interface KnowledgeSourceResult {
  attempted: number;
  succeeded: number;
  failed: number;
  dataStoreId?: string;
  error?: string;
}

/** Search for candidate files matching a knowledge source's filename, scoped
 *  to the person who added it (OneDrive) and/or known SharePoint sites —
 *  never a tenant-wide sweep. Returns candidates only; nothing is migrated
 *  until one is confirmed via confirmKnowledgeSource(). */
export async function findKnowledgeCandidates(
  session: string,
  filename: string,
  opts?: { envUrl?: string; modifiedByUserId?: string; sharePointSiteIds?: string[] },
): Promise<{ candidates: KnowledgeCandidate[]; scopedToUser: string | null }> {
  const res = await fetch('/api/migrate/knowledge-candidates', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, filename, ...opts }),
  });
  if (!res.ok) throw new Error('knowledge_candidates_failed');
  return (await res.json()) as { candidates: KnowledgeCandidate[]; scopedToUser: string | null };
}

/** Confirm a candidate (or a manually-identified drive item) as the real
 *  source and migrate it into the agent's knowledge for real. */
export async function confirmKnowledgeSource(
  session: string,
  agentId: string,
  candidate: Pick<KnowledgeCandidate, 'driveId' | 'itemId' | 'name'>,
): Promise<KnowledgeSourceResult> {
  const res = await fetch('/api/migrate/knowledge-source-confirm', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, agentId, ...candidate }),
  });
  const json = (await res.json()) as KnowledgeSourceResult & { detail?: string; error?: string };
  if (!res.ok) throw new Error(json.detail ?? json.error ?? 'knowledge_source_confirm_failed');
  return json;
}

export async function planMigration(
  session: string,
  scope: MigrationScope,
  destination: {
    projects?: Record<string, string>;
    environmentMap?: Record<string, GeminiDest>;
  },
  dryRun: boolean,
): Promise<PlanPreview> {
  const res = await fetch('/api/migrate/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, scope, destination, dryRun }),
  });
  if (!res.ok) throw new Error('plan_failed');
  return (await res.json()) as PlanPreview;
}

// ── Third-party connectors ────────────────────────────────────────────────────

export interface CredentialField {
  key: string;
  label: string;
  type: 'text' | 'password' | 'url';
  placeholder?: string;
  hint?: string;
}

export interface ConnectorDef {
  id: string;
  name: string;
  category: string;
  icon: string;
  docsUrl?: string;
  credentials: CredentialField[];
}

export interface DetectedConnector {
  connectorId: string;
  /** Absent when `unsupported` — the scan found the connector but we cannot call it.
   *  This mirrors the server type; it used to be declared non-optional here, which
   *  meant an unsupported connector crashed the page on `def.credentials` with nothing
   *  in typecheck to catch it. */
  def?: ConnectorDef;
  flowCount: number;
  flowNames: string[];
  /** Detected in a flow but not in our registry — shown as "cannot migrate", not hidden. */
  unsupported?: boolean;
  /** Which of the selected agents actually use this connector. */
  agentNames?: string[];
  /** The exact operations the agent invokes, e.g. ListIssues, GetIssue_V2. */
  operations?: string[];
  /**
   * 'certain'   — Copilot Studio named the connector itself (source kind enum or a
   *               shared_* api name), so this is a fact.
   * 'heuristic' — inferred from editable text on a generic federated source. Must be
   *               shown as "we think", never as a requirement.
   */
  confidence?: 'certain' | 'heuristic';
}

/** Scan Power Automate flows for third-party connector references in ONE environment. */
export async function fetchThirdPartyConnectors(session: string, envUrl: string): Promise<DetectedConnector[]> {
  const res = await fetch(`/api/migrate/third-party-connectors?session=${session}&envUrl=${encodeURIComponent(envUrl)}`);
  if (!res.ok) throw new Error('connector_scan_failed');
  return ((await res.json()) as { connectors: DetectedConnector[] }).connectors;
}

/** Scan knowledge-source botcomponents for specific agents — detects Confluence, etc. */
export async function fetchKnowledgeSourceConnectors(
  session: string,
  envUrl: string,
  botIds: string[],
): Promise<DetectedConnector[]> {
  const res = await fetch('/api/migrate/knowledge-connectors', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, envUrl, botIds }),
  });
  if (!res.ok) return []; // non-fatal — flow connectors still shown
  return ((await res.json()) as { connectors: DetectedConnector[] }).connectors;
}

/**
 * Prefer the server's `detail` over the error code when saving credentials.
 *
 * These failures are almost always an IAM grant the admin must make, and the fix is
 * in the detail string ("grant roles/secretmanager.admin on project X"). Throwing the
 * bare code forced the page to guess, and it guessed "Check that Google is connected"
 * — which sent admins to re-check a connection that was fine.
 */
async function saveErrorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; detail?: string };
    return body.detail || body.error || fallback;
  } catch {
    return fallback;
  }
}

export async function saveConnectorCredentials(
  session: string,
  connectorId: string,
  creds: Array<{ field: string; value: string }>,
): Promise<{ secretIds: string[]; validation?: ConnectorValidation }> {
  const res = await fetch('/api/migrate/third-party-connectors/credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, connectorId, creds }),
  });
  if (!res.ok) throw new Error(await saveErrorMessage(res, 'credentials_save_failed'));
  return (await res.json()) as { secretIds: string[]; validation?: ConnectorValidation };
}

/**
 * Result of testing a credential against the real provider API after saving it.
 *
 * `invalid_credentials` and `permission_denied` are kept apart because they need
 * different people to act: one is a wrong value to retype, the other is a consent or
 * access grant the value cannot fix. `unverified` means we did not test this connector
 * — not that it works.
 */
export interface ConnectorValidation {
  code: 'ok' | 'invalid_credentials' | 'permission_denied' | 'unreachable' | 'unverified';
  detail?: string;
  grantedPermissions?: string[];
}

/** One connector the customer has already configured. Never carries credential values. */
export interface SavedConnector {
  connectorId: string;
  fields: string[];
  project: string;
  updatedAt?: string;
  /** The secrets are in the project this migration targets. When false they exist but
   *  are unreachable from the destination, so the connector is NOT configured for
   *  this run — treating it as configured is what silently skipped knowledge sources. */
  matchesDestination?: boolean;
}

/**
 * Connectors this customer configured previously (persisted per customer, not per
 * session) so the UI can show "configured" instead of asking again for credentials
 * that are already in Secret Manager.
 */
export async function fetchSavedConnectors(session: string): Promise<SavedConnector[]> {
  const res = await fetch(`/api/migrate/connector-credentials?session=${session}`);
  if (!res.ok) throw new Error('saved_connectors_failed');
  const body = (await res.json()) as { connectors: SavedConnector[] };
  return body.connectors;
}

/** Forget our record of a connector so the form asks for credentials again.
 *  Leaves the Secret Manager secrets untouched. */
export async function forgetConnectorCredentials(session: string, connectorId: string): Promise<void> {
  const res = await fetch(
    `/api/migrate/connector-credentials?session=${session}&connectorId=${encodeURIComponent(connectorId)}`,
    { method: 'DELETE' },
  );
  if (!res.ok) throw new Error('connector_forget_failed');
}

/** What a connector needs before it can work — fields, permissions, group state. */
export interface ConnectorRequirement {
  connectorId: string;
  name?: string;
  icon?: string;
  authKind?: string;
  fields?: Array<{
    key: string; label: string; type: string; placeholder?: string; hint?: string; shared: boolean;
    /** A value is already in Secret Manager for this field — do not ask for it again. */
    supplied?: boolean;
  }>;
  requiredPermissions?: string[];
  adminConsentRequired?: boolean;
  permissionsHint?: string;
  group?: { id: string; name: string; setupUrl?: string; setupHint?: string; siblings: string[] };
  configured?: boolean;
  /** A sibling connector already supplied the shared credential — only permissions remain. */
  credentialAlreadySupplied?: boolean;
  unknown?: boolean;
}

/**
 * Fields + permissions + group state for the given connectors, in one call.
 * Permissions matter as much as credentials: a Microsoft client_credentials exchange
 * returns a token even when nothing is consented, and then every call 403s at runtime.
 */
export async function fetchConnectorRequirements(
  session: string,
  connectorIds: string[],
): Promise<ConnectorRequirement[]> {
  if (connectorIds.length === 0) return [];
  const res = await fetch(`/api/migrate/connector-requirements?session=${session}&ids=${encodeURIComponent(connectorIds.join(','))}`);
  if (!res.ok) throw new Error('connector_requirements_failed');
  return ((await res.json()) as { connectors: ConnectorRequirement[] }).connectors;
}

export async function saveMsConnectorCredentials(
  session: string,
  creds: Record<string, string>,
): Promise<{ secretIds: string[]; validation?: ConnectorValidation }> {
  const res = await fetch('/api/migrate/ms-connector-credentials', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session, creds }),
  });
  if (!res.ok) throw new Error(await saveErrorMessage(res, 'ms_creds_save_failed'));
  return (await res.json()) as { secretIds: string[]; validation?: ConnectorValidation };
}
