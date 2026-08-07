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
 * KNOWN GAP: the scope carries no appUserId, so two customers sharing one Google
 * project, or one customer with two Jira sites, would collide. Isolation today comes
 * only from each customer having their own project. See handoff.md — this is the top
 * item in the production hardening list.
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

/** Build a Secret Manager secret ID for one credential field. */
export function connectorSecretId(connectorIdOrScope: string, field: string): string {
  // Accepts either a connector id (resolved through its group) or an explicit scope,
  // so callers that already know the scope — or use a non-registry scope like
  // 'ms_native' — keep working unchanged.
  const scope = REGISTRY_BY_ID.has(connectorIdOrScope)
    ? connectorFieldScope(connectorIdOrScope, field)
    : connectorIdOrScope;
  const safeScope = scope.replace(/_/g, '-').toLowerCase();
  const safeField = field.replace(/_/g, '-').toLowerCase();
  return `studio-enterprise-${safeScope}-${safeField}`;
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
  if (!def) return [];
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
