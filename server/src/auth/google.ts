import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config, GOOGLE_SCOPES, SA_SCOPES } from '../config.js';
import { logger } from '../logger.js';

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
 * Mint a GCP access token from the service account. When `impersonate` is set,
 * uses Domain-Wide Delegation to act as that user.
 */
export async function getSaToken(impersonate?: string): Promise<string> {
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

/**
 * Auto-discover the GCP project number that hosts the customer's Gemini
 * Enterprise (agentspace) engine by scanning their accessible projects.
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
    // Client-agnostic: LIST engines per project (don't assume any engine id —
    // client apps have arbitrary ids like "gemini-enterprise-…"). Prefer a
    // project with a chat/assistant-capable engine; otherwise take the first
    // project that has any engine at all.
    let firstWithEngine = '';
    for (const p of json.projects ?? []) {
      if (p.lifecycleState !== 'ACTIVE' || !p.projectNumber) continue;
      const listRes = await fetch(
        `https://discoveryengine.googleapis.com/v1alpha/projects/${p.projectNumber}` +
          `/locations/global/collections/default_collection/engines`,
        { headers: { Authorization: `Bearer ${gToken}` } },
      );
      if (!listRes.ok) continue;
      const engines = ((await listRes.json()) as { engines?: { solutionType?: string }[] }).engines ?? [];
      if (!engines.length) continue;
      if (engines.some((e) => /CHAT|ASSISTANT/i.test(e.solutionType ?? ''))) return p.projectNumber;
      if (!firstWithEngine) firstWithEngine = p.projectNumber;
    }
    if (firstWithEngine) return firstWithEngine;
  } catch (err) {
    logger.warn({ err }, 'Gemini project discovery failed');
  }
  return fallback;
}
