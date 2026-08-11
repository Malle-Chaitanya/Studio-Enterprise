import { config, MS_SCOPES } from '../config.js';
import { logger } from '../logger.js';

/**
 * Microsoft identity + Power Platform helpers.
 *
 * Ports the POC's proven flow: authorization-code login for the admin, then
 * client_credentials tokens (BAP, Dataverse) using CloudFuze's multi-tenant app,
 * which the customer admin consents to. All tokens are per-tenant.
 */

const LOGIN = (tenant: string) => `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

async function tokenRequest(tenant: string, body: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(LOGIN(tenant), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body),
  });
  const json = (await res.json()) as TokenResponse & { error?: string; error_description?: string };
  if (!res.ok) {
    throw new Error(`MS token error (${res.status}): ${json.error_description ?? json.error ?? 'unknown'}`);
  }
  return json;
}

/** Build the interactive login URL the browser is redirected to. */
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: config.MS_REDIRECT_URI,
    response_mode: 'query',
    scope: MS_SCOPES,
    state,
    // 'consent' forces Microsoft's permissions screen on every sign-in, even
    // if this account already approved the app before. 'select_account'
    // (the old value) only shows the account picker and silently reuses any
    // prior consent — customer admins never saw what they were granting.
    prompt: 'consent',
  });
  return `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params}`;
}

/** Exchange an authorization code for tokens. */
export async function exchangeCode(code: string): Promise<TokenResponse> {
  return tokenRequest('common', {
    client_id: config.MS_CLIENT_ID,
    client_secret: config.MS_CLIENT_SECRET,
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.MS_REDIRECT_URI,
    scope: MS_SCOPES,
  });
}

/** Decode the tenant id (tid) from a JWT access token without verifying it. */
export function tenantIdFromToken(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  if (!payload) return '';
  const json = Buffer.from(payload, 'base64').toString('utf8');
  try {
    return (JSON.parse(json).tid as string) ?? '';
  } catch {
    return '';
  }
}

/** App-only token for a given resource (BAP, Dataverse org, etc.). */
export async function clientCredsToken(tenant: string, resource: string): Promise<string> {
  const t = await tokenRequest(tenant, {
    client_id: config.MS_CLIENT_ID,
    client_secret: config.MS_CLIENT_SECRET,
    scope: `${resource}/.default`,
    grant_type: 'client_credentials',
  });
  return t.access_token;
}

/** Exchange a refresh token for a Dataverse-scoped delegated token. */
export async function delegatedDataverseToken(
  tenant: string,
  refreshToken: string,
  dvUrl: string,
): Promise<{ token: string; refreshToken: string } | null> {
  try {
    const t = await tokenRequest(tenant, {
      client_id: config.MS_CLIENT_ID,
      client_secret: config.MS_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: `${dvUrl}/.default offline_access`,
    });
    return { token: t.access_token, refreshToken: t.refresh_token ?? refreshToken };
  } catch (err) {
    logger.warn({ err }, 'delegated Dataverse token exchange failed');
    return null;
  }
}

export interface OrgEnvironment {
  name: string;
  url: string;
  id: string;
}

/** Exchange a refresh token for a Microsoft Graph-scoped delegated token. */
export async function graphTokenFromRefresh(tenant: string, refreshToken: string): Promise<string | null> {
  try {
    const t = await tokenRequest(tenant, {
      client_id: config.MS_CLIENT_ID,
      client_secret: config.MS_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      scope: 'https://graph.microsoft.com/.default offline_access',
    });
    return t.access_token;
  } catch (err) {
    logger.warn({ err }, 'graph token exchange failed');
    return null;
  }
}

/** All verified domains for the tenant (Graph organization.verifiedDomains). */
export async function getVerifiedDomains(graphToken: string): Promise<string[]> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/organization?$select=verifiedDomains', {
      headers: { Authorization: `Bearer ${graphToken}` },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as { value?: { verifiedDomains?: { name?: string }[] }[] };
    return (json.value?.[0]?.verifiedDomains ?? [])
      .map((d) => d.name?.toLowerCase())
      .filter((n): n is string => Boolean(n));
  } catch {
    return [];
  }
}

export interface GraphUserBrief {
  id: string;
  email: string;
  displayName?: string;
  userPrincipalName?: string;
  accountEnabled?: boolean;
}

/**
 * List Microsoft Graph users for the Map Users grid (paginated, searchable).
 * Uses delegated Graph token from the admin refresh token.
 */
export async function listGraphUsers(
  graphToken: string,
  opts?: { max?: number; query?: string },
): Promise<GraphUserBrief[]> {
  const max = Math.min(Math.max(opts?.max ?? 200, 1), 999);
  const q = (opts?.query || '').trim();
  const select = '$select=id,displayName,mail,userPrincipalName,accountEnabled';
  let url: string | null = q
    ? `https://graph.microsoft.com/v1.0/users?${select}&$top=${Math.min(max, 100)}&$filter=${encodeURIComponent(
        `startswith(displayName,'${q.replace(/'/g, '')}') or startswith(mail,'${q.replace(/'/g, '')}') or startswith(userPrincipalName,'${q.replace(/'/g, '')}')`,
      )}`
    : `https://graph.microsoft.com/v1.0/users?${select}&$top=${Math.min(max, 100)}&$orderby=displayName`;

  const out: GraphUserBrief[] = [];
  while (url && out.length < max) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${graphToken}` } });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(`graph_users_failed ${res.status}: ${t.slice(0, 200)}`);
    }
    const json = (await res.json()) as {
      value?: {
        id?: string;
        displayName?: string;
        mail?: string;
        userPrincipalName?: string;
        accountEnabled?: boolean;
      }[];
      '@odata.nextLink'?: string;
    };
    for (const u of json.value ?? []) {
      const email = (u.mail || u.userPrincipalName || '').toLowerCase();
      if (!email || !u.id) continue;
      out.push({
        id: u.id,
        email,
        displayName: u.displayName,
        userPrincipalName: u.userPrincipalName,
        accountEnabled: u.accountEnabled,
      });
      if (out.length >= max) break;
    }
    url = out.length < max ? (json['@odata.nextLink'] ?? null) : null;
  }
  return out;
}

/** Look up the org display name via Graph. */
export async function getOrgName(adminToken: string, fallback: string): Promise<string> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/organization', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    if (!res.ok) return fallback;
    const json = (await res.json()) as { value?: { displayName?: string }[] };
    return json.value?.[0]?.displayName ?? fallback;
  } catch {
    return fallback;
  }
}

/** Best-effort account email / UPN from the delegated access token's claims. */
export function emailFromToken(accessToken: string): string {
  const payload = accessToken.split('.')[1];
  if (!payload) return '';
  try {
    const json = JSON.parse(Buffer.from(payload, 'base64').toString('utf8')) as Record<string, unknown>;
    return (
      (json.preferred_username as string) ||
      (json.upn as string) ||
      (json.email as string) ||
      (json.unique_name as string) ||
      ''
    );
  } catch {
    return '';
  }
}

/** Discover all Dataverse-backed environments in the tenant via the BAP admin API. */
export async function discoverEnvironments(tenant: string): Promise<OrgEnvironment[]> {
  const bapToken = await clientCredsToken(tenant, 'https://api.bap.microsoft.com');
  const res = await fetch(
    'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform' +
      '/scopes/admin/environments?api-version=2020-10-01',
    { headers: { Authorization: `Bearer ${bapToken}` } },
  );
  if (!res.ok) {
    logger.warn({ status: res.status }, 'BAP environment discovery failed');
    return [];
  }
  const json = (await res.json()) as {
    value?: {
      name?: string;
      properties?: { displayName?: string; linkedEnvironmentMetadata?: { instanceUrl?: string } };
    }[];
  };
  const envs: OrgEnvironment[] = [];
  for (const env of json.value ?? []) {
    const url = env.properties?.linkedEnvironmentMetadata?.instanceUrl;
    if (url) {
      envs.push({
        name: env.properties?.displayName ?? '',
        url: url.replace(/\/$/, ''),
        id: env.name ?? '',
      });
    }
  }
  return envs;
}

/** Confirm the Power Platform admin application is registered for this tenant. */
export async function verifyPpAdminApp(tenant: string): Promise<boolean> {
  try {
    const bapToken = await clientCredsToken(tenant, 'https://api.bap.microsoft.com');
    const res = await fetch(
      'https://api.bap.microsoft.com/providers/Microsoft.BusinessAppPlatform' +
        '/adminApplications?api-version=2020-10-01',
      { headers: { Authorization: `Bearer ${bapToken}` } },
    );
    return res.ok;
  } catch {
    return false;
  }
}
