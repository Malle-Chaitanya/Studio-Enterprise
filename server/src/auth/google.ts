import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config, GOOGLE_SCOPES, SA_SCOPES } from '../config.js';
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
export async function getSaToken(impersonate?: string): Promise<string> {
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
    scopes: SA_SCOPES,
    subject: impersonate,
  });
  const { access_token: token } = await client.authorize();
  if (!token) throw new Error('Service account returned no access token');
  return token;
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

/** Exchange an authorization code for a Google access token (identity/discovery only). */
export async function exchangeCode(code: string): Promise<string> {
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
  const json = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google token error (${res.status}): ${json.error ?? 'unknown'}`);
  }
  return json.access_token;
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
  try {
    const res = await fetch('https://cloudresourcemanager.googleapis.com/v1/projects', {
      headers: { Authorization: `Bearer ${gToken}` },
    });
    if (!res.ok) return fallback;
    const json = (await res.json()) as {
      projects?: { projectNumber?: string; lifecycleState?: string }[];
    };
    const active = (json.projects ?? []).filter(
      (p): p is { projectNumber: string; lifecycleState?: string } =>
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
        if (!listRes.ok) return { projectNumber: p.projectNumber, hasChat: false, hasAny: false };
        const engines = ((await listRes.json()) as { engines?: { solutionType?: string }[] }).engines ?? [];
        return {
          projectNumber: p.projectNumber,
          hasChat: engines.some((e) => /CHAT|ASSISTANT/i.test(e.solutionType ?? '')),
          hasAny: engines.length > 0,
        };
      } catch {
        return { projectNumber: p.projectNumber, hasChat: false, hasAny: false };
      }
    });

    // `find` preserves input order → same deterministic choice as the old loop.
    const chat = probes.find((r) => r.hasChat);
    if (chat) return chat.projectNumber;
    const any = probes.find((r) => r.hasAny);
    if (any) return any.projectNumber;
  } catch (err) {
    logger.warn({ err }, 'Gemini project discovery failed');
  }
  return fallback;
}
