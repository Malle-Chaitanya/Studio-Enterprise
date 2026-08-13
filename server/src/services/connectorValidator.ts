import { logger } from '../logger.js';
import { connectorCredentialScope } from './connectorCredentials.js';

/**
 * Prove a connector's credentials actually work, the way the deployed agent will use
 * them — mint whatever token the runtime mints, then make one real read call.
 *
 * WHY THIS EXISTS: storing a credential proves only that Secret Manager accepted the
 * bytes. "✓ Saved" meant saved, not works, so a wrong secret or a missing admin consent
 * was discovered by the customer mid-conversation, weeks later, as an agent that
 * answered "I cannot reach Jira". The failure surfaced as far as possible from the
 * screen where it was introduced.
 *
 * A token mint is NOT enough on its own. Entra returns a perfectly valid
 * client_credentials token for an app with no application permissions consented, and
 * every Graph call then 403s — so the mint succeeds and the connector is still broken.
 * Only a real call separates "credential wrong" from "permission missing".
 *
 * The distinction matters because it changes who fixes it and how:
 *   invalid_credentials → the value is wrong; retype it
 *   permission_denied   → the value is right; an admin must consent/grant access
 * Collapsing both into "failed" sends admins to regenerate a token that was never the
 * problem.
 *
 * Connectors outside the validated set return `unverified` rather than `ok`. Claiming a
 * credential works because we did not check it is the overclaiming this project treats
 * as a trust failure.
 */

export type ConnectorValidationCode =
  | 'ok'
  | 'invalid_credentials'
  | 'permission_denied'
  | 'unreachable'
  | 'unverified';

export interface ConnectorValidation {
  code: ConnectorValidationCode;
  /** Human detail naming the real cause and, where possible, the fix. */
  detail?: string;
  /** For Microsoft: the application permissions actually consented on the token. */
  grantedPermissions?: string[];
}

/** Timeout so a hung provider cannot hold the save request open. */
const TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validate credentials for one connector.
 *
 * `values` is the complete credential set (group fields included), already merged with
 * anything previously stored — validating a partial set would report a false failure
 * for a field the admin simply did not retype.
 */
export async function validateConnectorCredentials(
  connectorId: string,
  values: Record<string, string>,
): Promise<ConnectorValidation> {
  try {
    switch (connectorCredentialScope(connectorId)) {
      case 'ms_graph':
        return await validateMsGraph(values);
      case 'atlassian':
        return await validateAtlassian(connectorId, values);
      case 'hubspot':
      case 'shared_hubspot':
        return await validateHubSpot(values);
      default:
        return {
          code: 'unverified',
          detail:
            'CloudFuze Studio Migrate cannot yet test this connector automatically. The credentials were stored, ' +
            'but whether they work will only be known when the migrated agent calls the API.',
        };
    }
  } catch (err) {
    // A validator crash must never lose a credential the customer already supplied.
    logger.warn({ connectorId, err: (err as Error).message }, 'connector validation threw');
    return { code: 'unreachable', detail: `Could not complete the check: ${(err as Error).message}` };
  }
}

/**
 * Microsoft: client_credentials mint, then one real Graph call.
 *
 * The token's `roles` claim lists the application permissions that were actually
 * consented, which is a far clearer signal than inferring consent from a 403 — an app
 * with no roles at all is an admin-consent problem every time.
 */
async function validateMsGraph(v: Record<string, string>): Promise<ConnectorValidation> {
  const tenant = v.tenant_id?.trim();
  const clientId = v.client_id?.trim();
  const clientSecret = v.client_secret?.trim();
  if (!tenant || !clientId || !clientSecret) {
    return { code: 'invalid_credentials', detail: 'Tenant ID, client ID and client secret are all required.' };
  }

  const tokenRes = await fetchWithTimeout(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: 'https://graph.microsoft.com/.default',
    }),
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    // AADSTS7000215 = wrong secret, AADSTS700016 = unknown client, AADSTS90002 = bad tenant.
    // Naming which of the three is wrong saves an admin from re-checking all of them.
    const detail = /AADSTS7000215/.test(body)
      ? 'The client secret is not valid for this application.'
      : /AADSTS700016|AADSTS90002/.test(body)
        ? 'The tenant ID or client ID does not match an application in that directory.'
        : `Microsoft rejected the credentials (${tokenRes.status}).`;
    return { code: 'invalid_credentials', detail };
  }

  const token = ((await tokenRes.json()) as { access_token?: string }).access_token;
  if (!token) return { code: 'invalid_credentials', detail: 'Microsoft returned no access token.' };

  let roles: string[] = [];
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')) as { roles?: string[] };
    roles = payload.roles ?? [];
  } catch {
    /* claims are a diagnostic nicety — the live call below is the real test */
  }
  if (roles.length === 0) {
    return {
      code: 'permission_denied',
      detail:
        'The app registration is valid, but no application permissions have been consented, so every API call will fail. ' +
        'Add the required Application permissions in Entra and click "Grant admin consent".',
      grantedPermissions: [],
    };
  }

  const probe = await fetchWithTimeout('https://graph.microsoft.com/v1.0/sites?search=&$top=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (probe.status === 401) {
    return { code: 'invalid_credentials', detail: 'Microsoft Graph rejected the token.', grantedPermissions: roles };
  }
  if (probe.status === 403) {
    return {
      code: 'permission_denied',
      detail: `The app is missing a required permission. Consented today: ${roles.join(', ')}.`,
      grantedPermissions: roles,
    };
  }
  if (!probe.ok && probe.status !== 404) {
    return { code: 'unreachable', detail: `Microsoft Graph returned ${probe.status}.`, grantedPermissions: roles };
  }
  // 404 counts as success: authentication and authorization both passed, there simply
  // was nothing matching the probe query in this tenant.
  return { code: 'ok', grantedPermissions: roles };
}

/**
 * Atlassian: Basic auth is base64(email:api_token). One call to /rest/api/3/myself,
 * which every valid token can reach.
 *
 * 200 with an anonymous body is the trap here — Atlassian answers some endpoints
 * anonymously, so a dead token can look like a working one until a real query returns
 * nothing. The response must actually identify an account.
 */
async function validateAtlassian(connectorId: string, v: Record<string, string>): Promise<ConnectorValidation> {
  const baseUrl = (v.base_url ?? '').trim().replace(/\/+$/, '');
  const email = v.email?.trim();
  const apiToken = v.api_token?.trim();
  if (!baseUrl || !email || !apiToken) {
    return { code: 'invalid_credentials', detail: 'Site URL, account email and API token are all required.' };
  }
  const auth = Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64');
  const res = await fetchWithTimeout(`${baseUrl}/rest/api/3/myself`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (res.status === 401) {
    return { code: 'invalid_credentials', detail: 'Atlassian rejected the email and API token pair.' };
  }
  if (res.status === 403) {
    return {
      code: 'permission_denied',
      detail: 'The token is valid but the account has no access to this site.',
    };
  }
  if (!res.ok) return { code: 'unreachable', detail: `Atlassian returned ${res.status} for ${baseUrl}.` };

  const me = (await res.json().catch(() => ({}))) as { accountId?: string; emailAddress?: string };
  if (!me.accountId) {
    return {
      code: 'invalid_credentials',
      detail: 'Atlassian answered anonymously — the API token is not being accepted for this account.',
    };
  }

  // Jira specifically: reaching /myself does not prove the account can search issues,
  // which is the only thing the migrated agent actually does with it.
  if (/jira/i.test(connectorId)) {
    const search = await fetchWithTimeout(
      `${baseUrl}/rest/api/3/search/jql?jql=${encodeURIComponent('created >= -365d ORDER BY created DESC')}&maxResults=1`,
      { headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' } },
    );
    if (search.status === 403) {
      return { code: 'permission_denied', detail: `${me.emailAddress ?? 'The account'} cannot search issues on this site.` };
    }
    if (!search.ok) {
      return { code: 'unreachable', detail: `Jira issue search returned ${search.status}.` };
    }
  }
  return { code: 'ok' };
}

/** HubSpot: a private app token is a bearer token; scopes show up as 403 on the probe. */
async function validateHubSpot(v: Record<string, string>): Promise<ConnectorValidation> {
  // `api_key` FIRST — it is the key the HubSpot credential group actually declares
  // (registry.ts: `{ key: 'api_key', label: 'Private App Token' }`), and it was the one
  // spelling this list did not contain. So every HubSpot save reported
  // `invalid_credentials — A HubSpot private app token is required` no matter how good the
  // token was: the validator was reading an empty string and blaming the customer for it
  // (live 2026-08-13, shared_hubspotsettingsv2 and shared_hubspotcrm). A validator that can
  // fail without ever calling the vendor is worse than no validator, because its verdict
  // reads as the vendor's.
  const token = (v.api_key ?? v.api_token ?? v.access_token ?? v.private_app_token ?? '').trim();
  if (!token) return { code: 'invalid_credentials', detail: 'A HubSpot private app token is required.' };
  const res = await fetchWithTimeout('https://api.hubapi.com/crm/v3/objects/contacts?limit=1', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (res.status === 401) return { code: 'invalid_credentials', detail: 'HubSpot rejected the token.' };
  if (res.status === 403) {
    return {
      code: 'permission_denied',
      detail: 'The token is valid but the private app is missing the CRM scopes the agent needs (crm.objects.contacts.read).',
    };
  }
  if (!res.ok) return { code: 'unreachable', detail: `HubSpot returned ${res.status}.` };
  return { code: 'ok' };
}
