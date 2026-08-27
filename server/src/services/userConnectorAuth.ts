import { randomBytes } from 'node:crypto';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { connectorUserSecretId } from './connectorCredentials.js';
import { upsertSecret } from './secretManager.js';
import { logger } from '../logger.js';

/**
 * One END USER authorizing one connector for themselves.
 *
 * WHY THIS EXISTS. Copilot Studio tools can run under the signed-in user's own connection
 * (`invoker`): Erik's mail leaves Erik's mailbox, Erik's CRM query returns only Erik's
 * records. We deploy tools with one shared credential, so migrating an `invoker` tool
 * silently makes every user act as one account. That is not a failure anyone can test for —
 * the tool works, it just answers for the wrong person.
 *
 * Reproducing it needs a refresh token PER PERSON. This module is how one gets there: build
 * the provider's consent URL, exchange the code the provider returns, and write the refresh
 * token to that person's own Secret Manager entry. The deployed container then reads it by
 * caller (`connectorUserSecretId`) and mints a short-lived access token per call, which the
 * `oauth2-refresh-token` path already knew how to do.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO. It never touches the shared credential, and it never
 * writes a per-user secret for anyone but the person who just completed the consent. A
 * "convenience" that copied one user's token to another would hand out their mailbox.
 */

/** Minutes a pending consent may sit unfinished before its state is refused. */
const STATE_TTL_MS = 10 * 60_000;

interface PendingConsent {
  appUserId: string;
  tenantId: string;
  /** The person consenting — the same identity Gemini later passes as `user_id`. */
  userKey: string;
  connectorId: string;
  ownerScope: string;
  project: string;
  redirectUri: string;
  /** Google identity to impersonate when reading/writing this user's secret. */
  saSubject?: string;
  at: number;
}

/**
 * In-flight consents, keyed by the opaque `state` we sent the provider.
 *
 * In memory on purpose. A pending consent is a property of THIS process for the next few
 * minutes; persisting it would leave rows behind for every user who opened the popup and
 * changed their mind. A restart mid-consent costs the user one retry, which is the correct
 * trade against durable litter.
 */
const pending = new Map<string, PendingConsent>();

function sweepExpired(now: number): void {
  for (const [k, v] of pending) if (now - v.at > STATE_TTL_MS) pending.delete(k);
}

export interface StartConsentArgs {
  appUserId: string;
  tenantId: string;
  userKey: string;
  connectorId: string;
  ownerScope: string;
  /** Destination project the per-user secret will be written to. */
  project: string;
  redirectUri: string;
  /** Google identity to impersonate when writing the secret, carried to the callback. */
  saSubject?: string;
  /** Stored credential values for this connector, used to fill {placeholders}. */
  fields: Record<string, string>;
}

export interface StartConsentResult {
  authorizeUrl: string;
  state: string;
}

/** True when per-user access can actually be reproduced for this connector. */
export function supportsUserAuth(connectorId: string): boolean {
  return Boolean(REGISTRY_BY_ID.get(connectorId)?.userAuth);
}

/**
 * The credential fields that belong to the PERSON, for the deployed container to key by
 * caller. Everything else on the connector — the client id and secret of the OAuth app —
 * is shared by every user and must keep resolving to the shared secret.
 *
 * `refresh_token` is the only one, and deliberately so: it is the single thing
 * `completeUserConsent` writes per user. Returning it for a connector with no `userAuth`
 * would promise the container a secret nothing ever stores, so an empty list is the honest
 * answer there — and the container reads empty as "fail every per-user call closed".
 */
export function perUserCredentialFields(connectorId: string): string[] {
  return supportsUserAuth(connectorId) ? ['refresh_token'] : [];
}

/**
 * The connector spec rewritten to run as the CALLER rather than as the app.
 *
 * Two things change together and must not be separated. The delegated fields tell the
 * container which secret ids to key by caller; the auth kind and scope switch the token
 * exchange from `client_credentials` (which authenticates the APPLICATION, identically for
 * everyone) to `refresh_token` (which authenticates the person). Marking `perUser` while
 * leaving `oauth2-client-credentials` in place would produce a tool that succeeds for every
 * caller as one shared identity — the exact silent collapse this whole path exists to stop.
 */
export function applyPerUserAuth<T extends {
  id: string; authKind?: string; scope?: string; tokenUrlTemplate?: string;
}>(conn: T): T & { perUser: true; perUserFields: string[] } {
  const def = REGISTRY_BY_ID.get(conn.id);
  const fields = perUserCredentialFields(conn.id);
  if (!def?.userAuth || !fields.length) {
    // No delegated flow exists for this connector. Mark it per-user anyway: the container
    // reads the empty field list and fails closed with a message naming the connector,
    // which is the truthful outcome. Silently leaving it shared is not.
    return { ...conn, perUser: true, perUserFields: [] };
  }
  return {
    ...conn,
    perUser: true,
    perUserFields: fields,
    authKind: 'oauth2-refresh-token',
    scope: def.userAuth.scope,
    tokenUrlTemplate: def.userAuth.tokenUrlTemplate,
  };
}

/**
 * Build the URL that asks ONE user to authorize ONE connector.
 *
 * Throws rather than returning a shared-credential fallback when the connector has no
 * delegated flow. A caller that silently fell back would deploy the tool as shared while the
 * UI told the user they had connected their own account.
 */
export function startUserConsent(args: StartConsentArgs): StartConsentResult {
  const def = REGISTRY_BY_ID.get(args.connectorId);
  if (!def?.userAuth) {
    throw new Error(`${args.connectorId} has no per-user authorization flow`);
  }
  if (!args.userKey) throw new Error('startUserConsent: userKey is required');

  const clientId = args.fields.client_id;
  if (!clientId) {
    // The customer registers the OAuth app; we never invent one. Saying so plainly beats
    // sending the user to a provider page that will reject them for a missing client_id.
    throw new Error(
      `${def.name}: no client_id is stored, so users cannot authorize it yet. `
      + 'Register an OAuth app for this connector and save its client id and secret first.',
    );
  }

  const fill = (tpl: string): string =>
    tpl.replace(/\{(\w+)\}/g, (_m, k: string) => args.fields[k] ?? `{${k}}`);

  const state = randomBytes(24).toString('base64url');
  const now = Date.now();
  sweepExpired(now);
  pending.set(state, {
    appUserId: args.appUserId,
    tenantId: args.tenantId,
    userKey: args.userKey,
    connectorId: args.connectorId,
    ownerScope: args.ownerScope,
    project: args.project,
    redirectUri: args.redirectUri,
    saSubject: args.saSubject,
    at: now,
  });

  const url = new URL(fill(def.userAuth.authorizeUrlTemplate));
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('redirect_uri', args.redirectUri);
  url.searchParams.set('scope', def.userAuth.scope);
  url.searchParams.set('state', state);
  // Microsoft returns a refresh token only when the consent is explicitly re-prompted for
  // offline access on the first grant; asking for consent is the reliable form across
  // providers and costs the user one extra click, once.
  url.searchParams.set('prompt', 'consent');
  return { authorizeUrl: url.toString(), state };
}

/**
 * The email the provider says it just authenticated, from the id_token's claims.
 *
 * Payload-only decode, deliberately: this token was returned directly to us by the token
 * endpoint over TLS on a request we client-authenticated, which is the one case OIDC
 * permits skipping signature validation. Returns '' when there is no id_token or it is
 * unreadable — callers MUST treat that as "unverified", never as "matched".
 */
function idTokenEmail(idToken?: string): string {
  if (!idToken) return '';
  try {
    const payload = idToken.split('.')[1];
    if (!payload) return '';
    const claims = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    ) as { email?: string; preferred_username?: string; upn?: string };
    return claims.email || claims.preferred_username || claims.upn || '';
  } catch {
    return '';
  }
}

/**
 * Read a pending consent WITHOUT consuming it.
 *
 * The callback needs to know which connector and project this state belongs to before it
 * can fetch the client secret the exchange requires — and it cannot consume the state to
 * find out, because a failed lookup would then burn the user's only attempt. Returns no
 * secret material; `completeUserConsent` still consumes the state exactly once.
 */
export function peekUserConsent(state: string): {
  appUserId: string; tenantId: string; userKey: string; connectorId: string;
  ownerScope: string; project: string; saSubject?: string;
} | null {
  const p = pending.get(state);
  if (!p || Date.now() - p.at > STATE_TTL_MS) return null;
  return {
    appUserId: p.appUserId, tenantId: p.tenantId, userKey: p.userKey,
    connectorId: p.connectorId, ownerScope: p.ownerScope, project: p.project,
    saSubject: p.saSubject,
  };
}

export interface CompleteConsentResult {
  connectorId: string;
  userKey: string;
  /** Secret ids actually written, so the caller can evidence what happened. */
  secretIds: string[];
  /**
   * Whether the provider confirmed WHICH person it authenticated. False means the token
   * was stored under the requested identity without proof — surface it, do not round it
   * up to "connected".
   */
  identityVerified: boolean;
}

/**
 * Exchange the provider's code and store the refresh token as that user's own credential.
 *
 * `saToken` writes to Secret Manager; `fields` supplies the client secret and any
 * {placeholders}. Nothing is written unless the provider actually returned a refresh token —
 * storing only an access token would produce a credential that works for an hour and then
 * fails with no explanation, which is worse than failing now.
 */
export async function completeUserConsent(
  state: string,
  code: string,
  saToken: string,
  fields: Record<string, string>,
): Promise<CompleteConsentResult> {
  const p = pending.get(state);
  // One-shot: a state is consumed whether or not the exchange succeeds, so a leaked
  // redirect cannot be replayed to mint a second credential for the same person.
  pending.delete(state);
  if (!p) throw new Error('consent_state_unknown');
  if (Date.now() - p.at > STATE_TTL_MS) throw new Error('consent_state_expired');

  const def = REGISTRY_BY_ID.get(p.connectorId);
  if (!def?.userAuth) throw new Error(`${p.connectorId} has no per-user authorization flow`);

  const fill = (tpl: string): string =>
    tpl.replace(/\{(\w+)\}/g, (_m, k: string) => fields[k] ?? `{${k}}`);

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: p.redirectUri,
    client_id: fields.client_id ?? '',
    client_secret: fields.client_secret ?? '',
    scope: def.userAuth.scope,
  });

  const res = await fetch(fill(def.userAuth.tokenUrlTemplate), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    // The provider's body can carry the client secret back in an error echo, so it is not
    // logged or returned — only the status, which is what a reader can act on.
    logger.warn(
      { connectorId: p.connectorId, status: res.status },
      'user consent: token exchange rejected',
    );
    throw new Error(`token_exchange_failed_${res.status}`);
  }
  const json = (await res.json()) as { refresh_token?: string; id_token?: string };

  // WHO DID THE PROVIDER ACTUALLY AUTHENTICATE? The pending state says who this consent is
  // FOR, but a consent link is a URL: forward it, click it yourself, or open it while signed
  // in as someone else, and the refresh token that comes back belongs to a different person
  // than the one it would be filed under. That is not a small mix-up — the deployed tool
  // would then act as the wrong human, which is the precise failure per-user credentials
  // exist to prevent, arrived at from the other direction.
  //
  // The id_token comes straight from the provider's token endpoint over TLS in response to
  // our own client-authenticated request, so its claims are trustworthy without separate
  // signature verification (OIDC Core 3.1.3.7 permits exactly this case).
  const authenticated = idTokenEmail(json.id_token);
  if (authenticated && authenticated.toLowerCase() !== p.userKey.toLowerCase()) {
    logger.warn(
      { connectorId: p.connectorId, expected: p.userKey, got: authenticated },
      'user consent: refused — provider authenticated a different person',
    );
    throw new Error('consent_identity_mismatch');
  }
  if (!authenticated) {
    // Not fatal: some providers issue no id_token. Say so rather than implying the binding
    // was checked — a silent "verified" here would be the dangerous half of honest.
    logger.warn(
      { connectorId: p.connectorId, user: p.userKey },
      'user consent: provider returned no id_token; identity binding is unverified',
    );
  }

  if (!json.refresh_token) {
    throw new Error(
      'no_refresh_token: the provider returned an access token but no refresh token, so this '
      + 'authorization would stop working within the hour. Check that the offline-access '
      + 'scope is requested and granted.',
    );
  }

  const secretId = connectorUserSecretId(
    p.connectorId, 'refresh_token', p.ownerScope, p.userKey,
  );
  await upsertSecret(saToken, p.project, secretId, json.refresh_token);
  // The identity is logged, never the token — see .claude/rules/security-rules.md.
  logger.info(
    { connectorId: p.connectorId, user: p.userKey, project: p.project },
    'user consent: stored a per-user connector credential',
  );
  return {
    connectorId: p.connectorId,
    userKey: p.userKey,
    secretIds: [secretId],
    identityVerified: Boolean(authenticated),
  };
}

/** Test seam: how many consents are waiting. Never exposed over HTTP. */
export function pendingConsentCount(): number {
  sweepExpired(Date.now());
  return pending.size;
}
