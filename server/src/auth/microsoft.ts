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
  /** Service plan names this user holds in an enabled state. Empty = unlicensed. */
  servicePlans?: string[];
}

/**
 * Why a directory listing is shorter than the directory.
 *
 * A filtered list that does not say what it dropped is indistinguishable from a small org,
 * and the person staring at the Map Users grid wondering where their colleague went has no
 * way to tell those apart. Every count here exists so the UI can explain the absence.
 */
export interface DirectoryFilterStats {
  /** Users returned after filtering. */
  returned: number;
  /** Dropped because the account is disabled. */
  excludedInactive: number;
  /** Dropped because the account holds no licence (or none of the required plans). */
  excludedUnlicensed: number;
  /** Dropped because the account is a guest/external identity. */
  excludedGuest: number;
  /**
   * Dropped because the account has no resolvable address at all (no mail, no UPN).
   *
   * Not a filter decision — these can never be a mapping target because there is nothing to
   * map them BY. Counted separately because it says something about the source tenant's data
   * quality rather than about anyone's licence, and because without it `returned + excluded`
   * silently fails to equal the directory size, which makes every other number here look
   * approximate.
   */
  excludedNoAddress: number;
  /**
   * 'applied'      — the licence signal was read and used.
   * 'unavailable'  — it could not be read, so licence filtering was SKIPPED rather than
   *                  applied blind. Never treat an unreadable licence as "unlicensed":
   *                  that empties the directory on an auth or scope problem and blames the
   *                  customer's licensing for our own failure.
   */
  licenceCheck: 'applied' | 'unavailable';
  /** Which service plans were required, if the deployment narrowed it. */
  requiredPlans?: string[];
}

/**
 * List Microsoft Graph users for the Map Users grid (paginated, searchable).
 * Uses delegated Graph token from the admin refresh token.
 */
export async function listGraphUsers(
  graphToken: string,
  opts?: { max?: number; query?: string; activeOnly?: boolean; licensedOnly?: boolean },
): Promise<GraphUserBrief[]> {
  return (await listGraphUsersFiltered(graphToken, opts)).users;
}

/**
 * Same listing, plus the reason the list is the length it is.
 *
 * Filtering is applied where Graph can do it (`accountEnabled eq true` is a server-side
 * filter, so disabled accounts never cross the wire) and in memory where it cannot
 * (`assignedPlans` has no usable OData filter for "holds any enabled plan").
 *
 * The licence rule is deliberately permissive by default — a user must hold at least one
 * ENABLED service plan, not a specific SKU. Demanding a named plan we guessed would hide
 * real people from the mapping grid and look exactly like those people not existing. Set
 * MS_REQUIRED_SERVICE_PLANS once the customer's actual SKU is known.
 */
export async function listGraphUsersFiltered(
  graphToken: string,
  opts?: { max?: number; query?: string; activeOnly?: boolean; licensedOnly?: boolean },
): Promise<{ users: GraphUserBrief[]; stats: DirectoryFilterStats }> {
  const activeOnly = opts?.activeOnly ?? config.DIRECTORY_ACTIVE_ONLY;
  const licensedOnly = opts?.licensedOnly ?? config.DIRECTORY_LICENSED_ONLY;
  const requiredPlans = config.MS_REQUIRED_SERVICE_PLANS.split(',')
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);
  const stats: DirectoryFilterStats = {
    returned: 0,
    excludedInactive: 0,
    excludedUnlicensed: 0,
    excludedGuest: 0,
    excludedNoAddress: 0,
    licenceCheck: 'applied',
    requiredPlans: requiredPlans.length ? requiredPlans : undefined,
  };

  const max = Math.min(Math.max(opts?.max ?? 200, 1), 999);
  const q = (opts?.query || '').trim();
  const select = '$select=id,displayName,mail,userPrincipalName,accountEnabled,userType,assignedPlans';
  // Escape single quotes by doubling them — OData's own escape. Stripping them instead
  // silently searches for something the user did not type (O'Brien -> OBrien finds nobody).
  const lit = (s: string): string => s.replace(/'/g, "''");
  const searchClause = q
    ? `(startswith(displayName,'${lit(q)}') or startswith(mail,'${lit(q)}') or startswith(userPrincipalName,'${lit(q)}'))`
    : '';
  // accountEnabled filters server-side, so disabled accounts never cross the wire. It also
  // means the inactive count below reports only what Graph still handed us.
  const activeClause = activeOnly ? 'accountEnabled eq true' : '';
  const filter = [searchClause, activeClause].filter(Boolean).join(' and ');
  const base = `https://graph.microsoft.com/v1.0/users?${select}&$top=${Math.min(max, 100)}`;
  let url: string | null = filter
    ? `${base}&$filter=${encodeURIComponent(filter)}`
    : `${base}&$orderby=displayName`;

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
        userType?: string;
        assignedPlans?: { servicePlanId?: string; service?: string; capabilityStatus?: string }[];
      }[];
      '@odata.nextLink'?: string;
    };
    // `assignedPlans` missing on EVERY row means the field was not returned to us (a
    // directory-read scope that does not include it), not that the whole tenant is
    // unlicensed. Filtering on that would empty the grid and blame the customer.
    let sawAnyPlansField = false;
    for (const u of json.value ?? []) {
      const email = (u.mail || u.userPrincipalName || '').toLowerCase();
      if (!email || !u.id) {
        stats.excludedNoAddress++;
        continue;
      }
      if (Array.isArray(u.assignedPlans)) sawAnyPlansField = true;

      if (activeOnly && u.accountEnabled === false) {
        stats.excludedInactive++;
        continue;
      }
      // Guests are external identities from another tenant. They cannot own a Copilot agent
      // here, so offering one as a mapping target produces a mapping that cannot resolve.
      if (activeOnly && (u.userType ?? '').toLowerCase() === 'guest') {
        stats.excludedGuest++;
        continue;
      }

      const servicePlans = (u.assignedPlans ?? [])
        .filter((p) => (p.capabilityStatus ?? '').toLowerCase() === 'enabled')
        .map((p) => (p.service ?? '').toUpperCase())
        .filter(Boolean);

      if (licensedOnly && Array.isArray(u.assignedPlans)) {
        const holdsRequired = requiredPlans.length
          ? servicePlans.some((p) => requiredPlans.some((r) => p.includes(r) || r.includes(p)))
          : servicePlans.length > 0;
        if (!holdsRequired) {
          stats.excludedUnlicensed++;
          continue;
        }
      }

      out.push({
        id: u.id,
        email,
        displayName: u.displayName,
        userPrincipalName: u.userPrincipalName,
        accountEnabled: u.accountEnabled,
        servicePlans,
      });
      if (out.length >= max) break;
    }
    if (licensedOnly && !sawAnyPlansField && (json.value ?? []).length > 0) {
      stats.licenceCheck = 'unavailable';
    }
    url = out.length < max ? (json['@odata.nextLink'] ?? null) : null;
  }

  // The licence signal never arrived, so nothing was filtered on it — say so rather than
  // presenting an unfiltered list as a filtered one.
  if (stats.licenceCheck === 'unavailable') {
    stats.excludedUnlicensed = 0;
    logger.warn(
      'Graph directory: assignedPlans not returned — licence filtering SKIPPED, showing all active users',
    );
  }
  stats.returned = out.length;
  return { users: out, stats };
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
