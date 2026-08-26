/**
 * Secret Manager naming for connector credentials.
 *
 * Naming: studio-enterprise-{scope}-{field}, where `scope` is the credential GROUP
 * when the connector belongs to one, otherwise the connector id (underscores → dashes
 * to satisfy Secret Manager's id rules).
 *
 * WHY THE GROUP MATTERS: one Azure App Registration serves all five Microsoft Graph
 * connectors, and one Atlassian API token serves both Confluence and Jira. Scoping by
 * connector id wrote five copies of the same client secret and — worse — made the UI
 * ask for credentials the customer had already supplied whenever a later migration
 * turned up another connector from the same family, when the only thing actually
 * needed was adding a permission to the app that already exists.
 *
 * TENANT SCOPING: the id also carries the appUserId, because the group scope alone
 * collides whenever two customers share one Google project — customer B's save
 * overwrites customer A's Jira token, and B's deployed agent then reads A's
 * credential. Isolation used to rest entirely on every customer having their own
 * project, which is an assumption the product does not enforce anywhere.
 *
 * READING ALREADY-STORED SECRETS: never recompute an id to READ with. Credentials
 * saved before tenant scoping live under `legacyConnectorSecretId`, and a deployed
 * agent has whatever id it was built with baked into its spec. The durable record
 * (db/repos/connectorCredentials.ts) stores the real id per field — resolve through
 * that, and treat the computed id as the value to use only when writing something new.
 */

import { REGISTRY_BY_ID, CREDENTIAL_GROUPS } from '../connectors/registry.js';
import type { CredentialField } from '../connectors/registry.js';

/**
 * The secret namespace for a connector: its credential group if it has one, else its
 * own id.
 */
export function connectorCredentialScope(connectorId: string): string {
  return REGISTRY_BY_ID.get(connectorId)?.credentialGroup ?? connectorId;
}

/**
 * Which scope a specific FIELD belongs to. Group fields are shared; fields a connector
 * declares itself are not — Dynamics 365 shares the Microsoft app but has its own
 * `org_url`, which must not land in the shared namespace where the next Microsoft
 * connector would overwrite it.
 */
export function connectorFieldScope(connectorId: string, field: string): string {
  const def = REGISTRY_BY_ID.get(connectorId);
  if (!def?.credentialGroup) return connectorId;
  const isOwnField = def.credentials.some((c) => c.key === field);
  return isOwnField ? connectorId : def.credentialGroup;
}

/** Secret Manager ids allow [a-zA-Z0-9_-] only; anything else becomes a dash. */
function secretSafe(part: string): string {
  return part.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();
}

/**
 * Build a Secret Manager secret ID for one credential field, scoped to one customer.
 *
 * `appUserId` is REQUIRED for anything the product writes. It is optional only so the
 * throwaway spikes in src/spikes/ — which run against a single known tenant — keep
 * working; omitting it in app code recreates the cross-tenant collision this scoping
 * exists to prevent.
 */
export function connectorSecretId(
  connectorIdOrScope: string,
  field: string,
  ownerScope: string,
): string {
  // Accepts either a connector id (resolved through its group) or an explicit scope,
  // so callers that already know the scope — or use a non-registry scope like
  // 'ms_native' — keep working unchanged.
  const scope = REGISTRY_BY_ID.has(connectorIdOrScope)
    ? connectorFieldScope(connectorIdOrScope, field)
    : connectorIdOrScope;
  // `ownerScope` is REQUIRED and the parameter is not optional, deliberately. It used to
  // be, falling back to the un-scoped legacy id when omitted — so a caller that simply
  // forgot it wrote into the namespace EVERY customer shares, silently. That is a
  // cross-tenant credential overwrite produced by an omission the compiler allowed. Use
  // `credentialScope(session)`; never pass a client-supplied value.
  return `studio-enterprise-${secretSafe(ownerScope)}-${secretSafe(scope)}-${secretSafe(field)}`;
}

/**
 * The same credential, but belonging to ONE end user rather than shared by everyone.
 *
 * Copilot's `invoker` tools ran under the signed-in user's own connection: Erik's mail left
 * Erik's mailbox, Erik's CRM query returned only Erik's records. Reproducing that means one
 * stored credential per person per connector, so the deployed tool can pick the caller's.
 *
 * Deliberately DERIVED from `connectorSecretId` rather than assembled again here. The shared
 * and per-user ids must agree on tenant scoping, group resolution and character-safing
 * forever; two independent builders of one name is how a lookup starts silently missing.
 *
 * `userKey` is the caller identity Gemini Enterprise passes to the deployed agent
 * (`user_id`, observed as the end user's email). It is safed like every other segment, so
 * `erik@filefuze.co` and `ERIK@filefuze.co` collapse to the same secret — which is correct:
 * they are one person to both clouds.
 */
export function connectorUserSecretId(
  connectorIdOrScope: string,
  field: string,
  ownerScope: string,
  userKey: string,
): string {
  const key = secretSafe(userKey.toLowerCase());
  if (!key) throw new Error('connectorUserSecretId: userKey is required');
  // `-u-` marks the per-user namespace. Without a marker a user called "prod" would be
  // indistinguishable from a field called "prod" in the flat id.
  return `${connectorSecretId(connectorIdOrScope, field, ownerScope)}-u-${key}`;
}

/**
 * The pre-tenant-scoping id. Kept because secrets written under it still exist and
 * still back deployed agents — this is a READ path for records that predate scoping,
 * never a name to write new credentials under.
 */
export function legacyConnectorSecretId(connectorIdOrScope: string, field: string): string {
  const scope = REGISTRY_BY_ID.has(connectorIdOrScope)
    ? connectorFieldScope(connectorIdOrScope, field)
    : connectorIdOrScope;
  return `studio-enterprise-${secretSafe(scope)}-${secretSafe(field)}`;
}

/**
 * Every credential field a connector needs, group fields first, each marked with
 * whether it is shared with other connectors. The UI uses `shared` to explain why a
 * field is already filled in ("you gave this for SharePoint") and to avoid asking for
 * the same Azure app five times.
 */
export function connectorCredentialFields(
  connectorId: string,
): Array<CredentialField & { shared: boolean; scope: string }> {
  const def = REGISTRY_BY_ID.get(connectorId);
  // A CUSTOM connector has no registry entry and never will. Returning [] here meant the
  // save path accepted no field for it, so even after the requirements screen learned to
  // ask for a token there was nowhere to put the answer. Custom connectors that bind do so
  // as `bearer-token` — a single secret sent as an Authorization header — so describe
  // exactly that one field. Its own scope, never a shared group: a token that happens to
  // reach the same vendor is still a different credential from the first-party one.
  if (!def) {
    if (!/^shared_/i.test(connectorId)) return [];
    return [
      {
        key: 'api_key',
        label: 'API token',
        type: 'password' as const,
        hint:
          'Sent verbatim as the Authorization header, exactly as Power Platform sends it — ' +
          'include any scheme prefix the vendor needs (e.g. "Bearer pat-na1-…").',
        shared: false,
        scope: connectorId,
      },
    ];
  }
  const groupFields = def.credentialGroup
    ? (CREDENTIAL_GROUPS[def.credentialGroup]?.credentials ?? []).map((f) => ({
        ...f,
        shared: true,
        scope: def.credentialGroup!,
      }))
    : [];
  const ownFields = def.credentials.map((f) => ({ ...f, shared: false, scope: connectorId }));
  return [...groupFields, ...ownFields];
}

/** Connector ids that share a credential group with the given connector. */
export function connectorsSharingCredentials(connectorId: string): string[] {
  const group = REGISTRY_BY_ID.get(connectorId)?.credentialGroup;
  if (!group) return [];
  return [...REGISTRY_BY_ID.values()]
    .filter((d) => d.credentialGroup === group && d.id !== connectorId)
    .map((d) => d.id);
}
