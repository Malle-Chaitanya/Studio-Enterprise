import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { ALL_SCOPES, config, GOOGLE_SCOPES, SA_DIRECTORY_SCOPES, SA_SCOPES } from '../config.js';
import { logger } from '../logger.js';
import { mapPoolCollect } from '../concurrency.js';

/**
 * Google identity + Service Account (Domain-Wide Delegation) helpers.
 *
 * The customer's Google OAuth is only used to identify their account and
 * Gemini project. All privileged Gemini operations use CloudFuze's service
 * account impersonating a customer admin via DWD — no browser session needed.
 */

function loadServiceAccountKey(): Record<string, unknown> {
  if (config.GOOGLE_SA_KEY_JSON) {
    return JSON.parse(config.GOOGLE_SA_KEY_JSON);
  }
  if (config.GOOGLE_SA_KEY_FILE) {
    return JSON.parse(readFileSync(config.GOOGLE_SA_KEY_FILE, 'utf8'));
  }
  throw new Error('No service account key configured (GOOGLE_SA_KEY_JSON or GOOGLE_SA_KEY_FILE).');
}

let saKeyCache: Record<string, unknown> | null = null;
function saKey(): Record<string, unknown> {
  if (!saKeyCache) saKeyCache = loadServiceAccountKey();
  return saKeyCache;
}

export function serviceAccountConfigured(): boolean {
  return Boolean(config.GOOGLE_SA_KEY_JSON || config.GOOGLE_SA_KEY_FILE);
}

/**
 * Parse the DWD impersonation allowlist (`GOOGLE_DWD_ALLOWED_IMPERSONATORS`) into
 * normalized, lowercased entries. Exported for unit tests.
 */
export function parseImpersonationAllowlist(raw?: string): string[] {
  return (raw ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Minimal shape check — we only mint impersonation tokens for real email targets.
const IMPERSONATION_EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Whether the service account is permitted to impersonate `email`.
 *
 * Security invariant: our SA holds Domain-Wide Delegation, so it CAN mint a token
 * for ANY user in a granting domain. We must never let it. Defense in depth:
 *   1. call sites only ever pass the session's OAuth-authenticated admin
 *      (server-derived `gEmail`), never a client-supplied value; and
 *   2. this check refuses malformed targets and — when an allowlist is configured
 *      — anything outside it (fail closed).
 * Allowlist entries are exact emails or bare/`@`-prefixed domains. An empty
 * allowlist means "no static restriction" (multi-tenant SaaS relies on layer 1).
 * Pure function (no I/O) so it is cheap to unit-test.
 */
export function impersonationAllowed(email: string, allowlist: string[]): boolean {
  const target = email.trim().toLowerCase();
  if (!IMPERSONATION_EMAIL_RE.test(target)) return false;
  if (allowlist.length === 0) return true;
  const domain = target.slice(target.indexOf('@') + 1);
  return allowlist.some((entry) =>
    entry.includes('@') ? entry.replace(/^@/, '') === domain || entry === target : entry === domain,
  );
}

/**
 * Mint a GCP access token from the service account. Called two ways:
 *   - `getSaToken()`            → the SA's OWN identity (customer granted Direct IAM).
 *   - `getSaToken(adminEmail)`  → impersonate that admin via Domain-Wide Delegation.
 *
 * `adminEmail` MUST be a server-derived, OAuth-authenticated session identity
 * (`session.gEmail`) — never client input. Before impersonating we re-check it
 * against the allowlist and fail closed, so a bug or tampered value can never turn
 * the SA's domain-wide power on an arbitrary user. The audit line logs the target
 * email only — never the token.
 */
async function mintSaToken(scopes: string[], impersonate?: string): Promise<string> {
  if (impersonate !== undefined) {
    const allowlist = parseImpersonationAllowlist(config.GOOGLE_DWD_ALLOWED_IMPERSONATORS);
    if (!impersonationAllowed(impersonate, allowlist)) {
      logger.warn(
        { impersonate, allowlistEnforced: allowlist.length > 0 },
        'blocked service-account impersonation (fail closed)',
      );
      throw new Error(`impersonation refused for target: ${impersonate}`);
    }
    logger.info({ impersonate }, 'service account impersonation (DWD)');
  }
  const key = saKey();
  const client = new JWT({
    email: key.client_email as string,
    key: key.private_key as string,
    scopes,
    subject: impersonate,
  });
  const { access_token: token } = await client.authorize();
  if (!token) throw new Error('Service account returned no access token');
  return token;
}

export async function getSaToken(impersonate?: string): Promise<string> {
  return mintSaToken(SA_SCOPES, impersonate);
}

/**
 * SA token with Admin Directory scopes only — used for Workspace user/domain
 * discovery. Must NOT be mixed into getSaToken() / Gemini writes (DWD allowlists
 * often only include cloud-platform).
 */
export async function getDirectorySaToken(impersonate?: string): Promise<string> {
  return mintSaToken(SA_DIRECTORY_SCOPES, impersonate);
}

/**
 * Mint a DWD access token by building and exchanging the JWT assertion OURSELVES,
 * rather than letting google-auth-library do it.
 *
 * `getSaToken(email)` above is the normal path and should stay the normal path — it
 * caches, refreshes, and retries. This exists for the cases where a raw token string
 * is the deliverable and the library is in the way:
 *
 *   - handing a short-lived impersonated token to the Python deployer, which today
 *     authenticates as the BARE service account. That is why customers with
 *     `constraints/iam.allowedPolicyMemberDomains` have to weaken the constraint to
 *     deploy at all: the SA itself needs a role binding. A DWD token carries the
 *     admin's authority instead, so nothing has to be granted to our SA.
 *   - reproducing a specific failure. When the library succeeds and a direct call
 *     fails, the assertion is the only place left to look.
 *
 * Mirrors the JWT-bearer flow in CloudFuze's Java stack (`getGoogleAccessToken`):
 * sign `{iss, sub, scope, aud, iat, exp}` with the SA private key, POST it as
 * `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, read `access_token`.
 *
 * Two deliberate differences from the Java version:
 *   - The impersonation allowlist is enforced BEFORE signing. The Java method will
 *     mint for any address it is handed; ours must not (see `impersonationAllowed`) —
 *     the SA holds domain-wide power and a raw email parameter is exactly the shape
 *     of call that turns it on the wrong person.
 *   - `expiresAt` is returned. The Java version returns a bare string, so callers
 *     cannot tell a fresh token from one about to expire mid-deploy — which for a
 *     15-minute Agent Engine build is the difference between a clean run and a
 *     half-finished orphan.
 *
 * Returns null when the exchange fails (matching the Java method's swallow-and-null),
 * and THROWS when the key or target is unusable — a misconfiguration is not a
 * transient failure and should not read as one. Never logs the token value.
 *
 * @param emailId     the Workspace user to impersonate (server-derived, never client input)
 * @param clientEmail override the SA client_email; defaults to the configured key's
 * @param scopes      defaults to SA_SCOPES (the Gemini/migration scopes)
 */
export async function getGoogleAccessToken(
  emailId: string,
): Promise<{ accessToken: string; expiresAt: Date } | null> {
  const TOKEN_URL = 'https://www.googleapis.com/oauth2/v4/token';

  const allowlist = parseImpersonationAllowlist(config.GOOGLE_DWD_ALLOWED_IMPERSONATORS);
  if (!impersonationAllowed(emailId, allowlist)) {
    logger.warn(
      { impersonate: emailId, allowlistEnforced: allowlist.length > 0 },
      'blocked service-account impersonation (fail closed)',
    );
    throw new Error(`impersonation refused for target: ${emailId}`);
  }

  const key = saKey();
  const iss = key.client_email as string;
  const privateKey = key.private_key as string;
  if (!iss || !privateKey) throw new Error('Service account key is missing client_email or private_key');

  const assertion = createJwtAssertion({
    iss,
    sub: emailId,
    scope: ALL_SCOPES.join(' '),
    aud: TOKEN_URL,
    privateKey,
  });

  logger.info({ impersonate: emailId }, 'service account impersonation (DWD, direct JWT assertion)');

  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }),
    });

    const body = await res.text();
    if (!res.ok) {
      // Log the STATUS and Google's error body, which names the actual cause
      // ("unauthorized_client" = DWD not authorized for these scopes in the Workspace
      // admin console; "invalid_grant" = clock skew or a sub that does not exist).
      // The assertion is not logged: it is a bearer credential for 60 minutes.
      logger.warn({ impersonate: emailId, status: res.status, body }, 'JWT-bearer token exchange failed');
      return null;
    }

    const json = JSON.parse(body) as { access_token?: string; expires_in?: number };
    if (!json.access_token) {
      logger.warn({ impersonate: emailId }, 'JWT-bearer token exchange returned no access_token');
      return null;
    }
    return {
      accessToken: json.access_token,
      expiresAt: new Date(Date.now() + (json.expires_in ?? 3600) * 1000),
    };
  } catch (err) {
    logger.error({ impersonate: emailId, err }, 'JWT-bearer token exchange threw');
    return null;
  }
}

/**
 * Build and RS256-sign the DWD assertion. Equivalent to the Java
 * `GsuiteJWTAssertion.createJWT(emailId, clientEmail)`.
 *
 * `sub` is what makes this Domain-Wide Delegation rather than a plain service-account
 * token: it tells Google to issue the token AS that user. Drop `sub` and Google happily
 * returns a token for the SA's own identity, which is the silent-wrong-identity bug this
 * whole flow exists to avoid.
 *
 * `iat` is backdated 10s because Google rejects an assertion whose `iat` is even
 * marginally in the future, and container clocks drift.
 */
function createJwtAssertion(opts: {
  iss: string;
  sub: string;
  scope: string;
  aud: string;
  privateKey: string;
}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: opts.iss,
    sub: opts.sub,
    scope: opts.scope,
    aud: opts.aud,
    iat: now - 10,
    // 3600 is Google's maximum for this grant; anything larger is rejected outright.
    exp: now + 3600,
  };
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${b64(header)}.${b64(claims)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(opts.privateKey, 'base64url');
  return `${signingInput}.${signature}`;
}

/**
 * Best-effort: list the Workspace's verified domains (Admin SDK Directory).
 * Requires the SA's DWD to include admin.directory.domain.readonly; without it
 * this 403s and returns [] — the org profile just falls back to other sources.
 */
export async function getWorkspaceDomains(saToken: string): Promise<string[]> {
  try {
    const res = await fetch('https://admin.googleapis.com/admin/directory/v1/customer/my_customer/domains', {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { domains?: { domainName?: string; verified?: boolean }[] };
    return (json.domains ?? [])
      .filter((d) => d.verified !== false)
      .map((d) => d.domainName?.toLowerCase())
      .filter((n): n is string => Boolean(n));
  } catch {
    return [];
  }
}

/**
 * Best-effort Workspace domains via a Directory-scoped DWD token (not the
 * cloud-platform migration token).
 */
export async function getWorkspaceDomainsAsAdmin(adminEmail: string): Promise<string[]> {
  try {
    const token = await getDirectorySaToken(adminEmail);
    return getWorkspaceDomains(token);
  } catch {
    return [];
  }
}

export interface WorkspaceUserBrief {
  email: string;
  displayName?: string;
  suspended?: boolean;
  /** True when the account is suspended, archived, or awaiting deletion. */
  inactive?: boolean;
}

/**
 * List of Workspace users for the Map Users grid. Requires DWD scope
 * admin.directory.user.readonly on an account with Workspace admin rights.
 * Throws with the real Admin SDK error on failure — the caller (route)
 * surfaces it to the UI instead of silently rendering an empty directory
 * that looks identical to "this org just has zero users."
 */
export async function listWorkspaceUsers(
  saToken: string,
  opts?: { max?: number; query?: string; activeOnly?: boolean },
): Promise<WorkspaceUserBrief[]> {
  return (await listWorkspaceUsersFiltered(saToken, opts)).users;
}

/**
 * Same listing, plus why it is the length it is.
 *
 * Suspended, archived and pending-deletion accounts are dropped: each one still appears in
 * the Directory API, and offering one as a mapping target produces a mapping that fails
 * much later during a share or a grant, where it reads as a migration bug rather than as
 * "that account is switched off".
 *
 * Licence filtering is NOT done here. The licence that matters on this side is a Gemini
 * Enterprise seat, which lives in Discovery Engine's user store rather than in the
 * directory — see `filterToLicensedPrincipals` in services/gemini.ts. Keeping the two apart
 * means a directory read still works when the licence read does not.
 */
export async function listWorkspaceUsersFiltered(
  saToken: string,
  opts?: { max?: number; query?: string; activeOnly?: boolean },
): Promise<{ users: WorkspaceUserBrief[]; excludedInactive: number }> {
  const activeOnly = opts?.activeOnly ?? config.DIRECTORY_ACTIVE_ONLY;
  let excludedInactive = 0;
  const max = Math.min(opts?.max ?? 200, 500);
  const users: WorkspaceUserBrief[] = [];
  let pageToken: string | undefined;
  while (users.length < max) {
    const params = new URLSearchParams({
      customer: 'my_customer',
      maxResults: String(Math.min(100, max - users.length)),
      orderBy: 'email',
      projection: 'basic',
    });
    // Directory `query` has no "active only" term, so suspension/archival is filtered
    // below from the returned fields rather than server-side.
    if (opts?.query) params.set('query', opts.query);
    if (pageToken) params.set('pageToken', pageToken);
    const res = await fetch(
      `https://admin.googleapis.com/admin/directory/v1/users?${params}`,
      { headers: { Authorization: `Bearer ${saToken}` } },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Admin Directory API ${res.status}: ${body.slice(0, 300) || res.statusText}`);
    }
    const json = (await res.json()) as {
      users?: {
        primaryEmail?: string;
        name?: { fullName?: string };
        suspended?: boolean;
        archived?: boolean;
        // Present while a deletion is pending; such an account still lists but must never
        // be offered as a mapping target.
        deletionTime?: string;
      }[];
      nextPageToken?: string;
    };
    for (const u of json.users ?? []) {
      if (!u.primaryEmail) continue;
      const inactive = !!(u.suspended || u.archived || u.deletionTime);
      if (activeOnly && inactive) {
        excludedInactive++;
        continue;
      }
      users.push({
        email: u.primaryEmail.toLowerCase(),
        displayName: u.name?.fullName,
        suspended: u.suspended,
        inactive,
      });
    }
    pageToken = json.nextPageToken;
    if (!pageToken) break;
  }
  return { users, excludedInactive };
}

/** List Workspace users using a Directory-scoped DWD token for `adminEmail`.
 *  Does NOT swallow errors — the route's own try/catch turns a thrown error
 *  into `{ users: [], error }` so the Map Users UI can tell "zero users
 *  found" apart from "the directory read itself failed." */
export async function listWorkspaceUsersAsAdmin(
  adminEmail: string,
  opts?: { max?: number; query?: string; activeOnly?: boolean },
): Promise<WorkspaceUserBrief[]> {
  const token = await getDirectorySaToken(adminEmail);
  return listWorkspaceUsers(token, opts);
}

/** As above, but also reports how many accounts were dropped as inactive. */
export async function listWorkspaceUsersFilteredAsAdmin(
  adminEmail: string,
  opts?: { max?: number; query?: string; activeOnly?: boolean },
): Promise<{ users: WorkspaceUserBrief[]; excludedInactive: number }> {
  const token = await getDirectorySaToken(adminEmail);
  return listWorkspaceUsersFiltered(token, opts);
}

/** Build the Google OAuth consent URL. */
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.GOOGLE_CLIENT_ID,
    response_type: 'code',
    redirect_uri: config.GOOGLE_REDIRECT_URI,
    scope: GOOGLE_SCOPES,
    state,
    access_type: 'offline',
    prompt: 'select_account consent',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}

/** Exchange an authorization code for a Google access token (identity/discovery only).
 *  buildAuthUrl already requests `access_type: offline`, so Google returns a
 *  refresh_token here too — callers MUST persist it (Session.gRefreshToken) and
 *  use refreshGoogleToken below once the ~1hr access token dies. Without it, a
 *  session older than an hour silently loses the ability to enumerate the
 *  admin's Cloud projects (see decisions.md, 2026-08-07 project-discovery gap). */
export async function exchangeCode(code: string): Promise<{ accessToken: string; refreshToken?: string }> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.GOOGLE_CLIENT_ID,
      client_secret: config.GOOGLE_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.GOOGLE_REDIRECT_URI,
    }),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; error?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token error (${res.status}): ${json.error ?? 'unknown'}`);
  }
  return { accessToken: json.access_token, refreshToken: json.refresh_token };
}

/** Exchange a stored Google refresh token for a fresh ~1hr access token. Google
 *  only returns a NEW refresh_token on rare rotation — the caller's existing one
 *  keeps working otherwise, so we don't overwrite it unless a new one comes back. */
export async function refreshGoogleToken(refreshToken: string): Promise<string | null> {
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.GOOGLE_CLIENT_ID,
        client_secret: config.GOOGLE_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
    });
    const json = (await res.json()) as { access_token?: string; error?: string };
    if (!res.ok || !json.access_token) {
      logger.warn(`Google token refresh failed (${res.status}): ${json.error ?? 'unknown'}`);
      return null;
    }
    return json.access_token;
  } catch (err) {
    logger.warn({ err }, 'Google token refresh errored');
    return null;
  }
}

/** The service-account email a CLIENT must grant access to (IAM or DWD). */
export function serviceAccountEmail(): string | undefined {
  try {
    return saKey().client_email as string;
  } catch {
    return undefined;
  }
}

/** The service-account OAuth client id a client adds to Domain-Wide Delegation. */
export function serviceAccountClientId(): string | undefined {
  try {
    return (saKey().client_id as string) ?? undefined;
  } catch {
    return undefined;
  }
}

/** Get the signed-in user's email. */
export async function getUserEmail(gToken: string): Promise<string> {
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v1/userinfo', {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    if (!res.ok) return 'unknown';
    const json = (await res.json()) as { email?: string };
    return json.email ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** How many per-project engine probes to run at once during discovery. */
const DISCOVERY_CONCURRENCY = 8;

/**
 * Auto-discover the GCP project number that hosts the customer's Gemini
 * Enterprise (agentspace) engine by scanning their accessible projects.
 *
 * The per-project engine probes run in PARALLEL (bounded) — the old sequential
 * loop was the main cause of slow sign-in for admins with many projects (it made
 * one Discovery Engine round-trip per project, awaited one at a time). Selection
 * is unchanged and deterministic: prefer the earliest project with a
 * chat/assistant-capable engine; otherwise the earliest with any engine; else the
 * configured fallback.
 */
export async function discoverGeminiProject(gToken: string): Promise<string> {
  const fallback = config.GEMINI_PROJECT_FALLBACK ?? '';

  // Explicit override wins over discovery. Discovery picks the FIRST project the
  // signed-in admin can see that has an engine, and the UI offers no way to choose a
  // different one — so an admin with several eligible projects gets whichever Cloud
  // Resource Manager happens to list first, with no signal that a choice was made.
  // Three consecutive runs on 2026-08-07 went to the wrong project this way, deployed
  // nothing, and looked like operator error.
  //
  // This is operator configuration, not a hardcoded id: it stays unset in normal
  // multi-tenant use, where discovery is correct. The real fix is a destination picker
  // in the wizard (the session already carries geminiProject) — see handoff.md.
  const forced = (process.env.GEMINI_PROJECT ?? '').trim();
  if (forced) {
    logger.info({ project: forced }, 'Gemini project forced by GEMINI_PROJECT (discovery skipped)');
    return forced;
  }

  /**
   * A project's ID, not its NUMBER.
   *
   * This returned `projectNumber`, which was then stored as `session.geminiProject` and read
   * everywhere else — and logged, and shown — as though it were an id. Google accepts either
   * in a URL, so nothing failed; the two simply stopped being distinguishable. Live
   * consequence: a run reported its destination as "studio-enterprise-migration" while
   * holding 505103737920, which is `agentmigrations` — a DIFFERENT project that happens to
   * share the display name "CloudFuze Agent Migration Hub". The preflight then demanded a
   * secret grant for the wrong project's service agent.
   *
   * Numbers are kept only as a fallback for the rare project the API returns without an id.
   */
  const projectRef = (p: { projectId?: string; projectNumber: string }): string =>
    p.projectId || p.projectNumber;

  try {
    const res = await fetch('https://cloudresourcemanager.googleapis.com/v1/projects', {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    if (!res.ok) return fallback;
    const json = (await res.json()) as {
      projects?: { projectNumber?: string; projectId?: string; lifecycleState?: string }[];
    };
    const active = (json.projects ?? []).filter(
      (p): p is { projectNumber: string; projectId?: string; lifecycleState?: string } =>
        p.lifecycleState === 'ACTIVE' && Boolean(p.projectNumber),
    );

    // Client-agnostic: LIST engines per project (don't assume any engine id —
    // client apps have arbitrary ids like "gemini-enterprise-…"). Probe all
    // projects concurrently; failed/empty probes just don't qualify.
    const probes = await mapPoolCollect(active, DISCOVERY_CONCURRENCY, async (p) => {
      try {
        const listRes = await fetch(
          `https://discoveryengine.googleapis.com/v1alpha/projects/${p.projectNumber}` +
            `/locations/global/collections/default_collection/engines`,
          { headers: { Authorization: `Bearer ${gToken}` } },
        );
        if (!listRes.ok) return { ref: projectRef(p), hasChat: false, hasAny: false };
        const engines = ((await listRes.json()) as { engines?: { solutionType?: string }[] }).engines ?? [];
        return {
          ref: projectRef(p),
          hasChat: engines.some((e) => /CHAT|ASSISTANT/i.test(e.solutionType ?? '')),
          hasAny: engines.length > 0,
        };
      } catch {
        return { ref: projectRef(p), hasChat: false, hasAny: false };
      }
    });

    // `find` preserves input order → same deterministic choice as the old loop.
    const chat = probes.find((r) => r.hasChat);
    if (chat) return chat.ref;
    const any = probes.find((r) => r.hasAny);
    if (any) return any.ref;
  } catch (err) {
    logger.warn({ err }, 'Gemini project discovery failed');
  }
  return fallback;
}

/**
 * Run a Discovery Engine read with the SA's two credential paths, in the order the
 * product intends: DIRECT IAM first (production — the customer granted our SA a role
 * on their project), then DWD impersonation of their admin.
 *
 * Extracted because the order was written out by hand in each caller and one of them
 * only ever tried direct IAM. That is invisible rather than loud: an org with
 * `constraints/iam.allowedPolicyMemberDomains` cannot grant an outside service account
 * any role, so direct IAM is not merely slower there — it can never succeed, and the
 * caller quietly degraded instead of using the DWD path that was working.
 *
 * `fn` is retried on a throw AND on a null result, because "read failed" reaches this
 * layer both ways. Returns null when neither path produced an answer — callers must
 * treat that as "unknown", never as "the answer is empty".
 */
export async function withSaTokens<T>(
  adminEmail: string | undefined,
  fn: (saToken: string) => Promise<T | null>,
): Promise<T | null> {
  try {
    const direct = await getSaToken();
    const viaDirect = await fn(direct);
    if (viaDirect != null) return viaDirect;
  } catch (err) {
    logger.warn({ err }, 'direct-IAM read failed; trying DWD');
  }
  if (!adminEmail) return null;
  const impersonated = await getSaToken(adminEmail);
  return fn(impersonated);
}
