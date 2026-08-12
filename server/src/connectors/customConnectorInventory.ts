/**
 * Every CUSTOM connector in a customer's environment, and whether we can call it.
 *
 * WHY THIS EXISTS. Until now a custom connector was discovered by accident: some agent
 * happened to reference one, its id happened to survive three separate parsers, and only
 * then did anyone learn it existed. That produced a card reading "shared_get — we don't
 * support this connector yet" for a connector that binds four HubSpot operations. The
 * failure was not any single parser; it was that nothing ever ASKED the platform what
 * custom connectors exist.
 *
 * A custom connector cannot be in our registry by definition — it is the customer's own,
 * built in their tenant, named whatever they typed. `isCustomApi: true` and
 * `metadata.source: powerapps-user-defined` are the platform saying so. So the registry
 * can never answer "what will this customer need"; only their environment can.
 *
 * Read-only: one admin listing per environment, one definition fetch per custom connector.
 * Nothing is created and no credential value is read — `apiDefinitions.originalSwaggerUrl`
 * carries a SAS token in its query string and is never logged or returned.
 */
import { logger } from '../logger.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { POWERAPPS_AUDIENCE, SAFE_CONNECTOR_ID, distilOriginalSwagger } from './captureOpIndex.js';

/** One custom connector, described well enough to decide what to do about it. */
export interface CustomConnectorInfo {
  connectorId: string;
  displayName: string;
  /** Who in the customer's tenant published it — the person to ask about its credential. */
  publisher?: string;
  createdBy?: string;
  createdTime?: string;
  /** The vendor host its operations actually reach, e.g. `api.hubapi.com`. */
  backendHost?: string;
  operationCount: number;
  /** Operation ids, so a report can say WHICH calls an agent would gain or lose. */
  operations: string[];
  /** True when we can build real tools for it today. */
  bindable: boolean;
  /** Why not, in words a customer can act on. Present only when `bindable` is false. */
  reason?: string;
  /**
   * Power Platform policies that rewrite the request before it reaches the backend. We
   * reproduce the definition, not the policies, so any non-zero count is a caveat on
   * every operation of this connector.
   */
  policyCount: number;
}

interface AdminApiRow {
  name?: string;
  properties?: {
    displayName?: string;
    isCustomApi?: boolean;
    publisher?: string;
    createdBy?: { email?: string; displayName?: string };
    createdTime?: string;
    backendService?: { serviceUrl?: string };
    apiDefinitions?: { originalSwaggerUrl?: string };
    policyTemplateInstances?: unknown[];
  };
}

/**
 * List the custom connectors in one environment.
 *
 * Uses the ADMIN scope deliberately. The user-scope endpoint answers
 * `403 ApiAuthorizationFailed` for any connector our app was never shared on, which would
 * force the customer to share each connector individually before a migration could even be
 * PLANNED. The admin scope we already hold lists them all with no customer action.
 *
 * Returns `undefined` when we COULD NOT LOOK, and `[]` when we looked and there were none.
 * Collapsing those two into `[]` is how "we have no idea" gets reported as "you have no
 * custom connectors" — the same mistake that let a whole environment's agents leave the
 * migration scope silently. Never throws: failing to enumerate must degrade the report,
 * not the migration.
 */
export async function listCustomConnectors(
  tenantId: string,
  environmentId: string,
): Promise<CustomConnectorInfo[] | undefined> {
  let rows: AdminApiRow[];
  try {
    const token = await clientCredsToken(tenantId, POWERAPPS_AUDIENCE);
    const url =
      `https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin` +
      `/environments/${encodeURIComponent(environmentId)}/apis?api-version=2016-11-01`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      logger.warn({ environmentId, status: res.status }, 'custom connector listing unavailable');
      return undefined;
    }
    rows = ((await res.json()) as { value?: AdminApiRow[] }).value ?? [];
  } catch (err) {
    logger.warn({ environmentId, err: (err as Error).message }, 'custom connector listing failed');
    return undefined;
  }

  // `isCustomApi` is the platform's own answer. Do not infer it from the id shape — a
  // guess here decides whether a connector is described or ignored entirely.
  const custom = rows.filter((r) => r.properties?.isCustomApi === true);
  const out: CustomConnectorInfo[] = [];

  for (const row of custom) {
    const id = row.name ?? '';
    const props = row.properties ?? {};
    const displayName = props.displayName ?? id;
    const base: CustomConnectorInfo = {
      connectorId: id,
      displayName,
      publisher: props.publisher,
      createdBy: props.createdBy?.email ?? props.createdBy?.displayName,
      createdTime: props.createdTime,
      backendHost: props.backendService?.serviceUrl,
      operationCount: 0,
      operations: [],
      bindable: false,
      policyCount: props.policyTemplateInstances?.length ?? 0,
    };

    if (!SAFE_CONNECTOR_ID.test(id)) {
      out.push({ ...base, reason: 'Its connector id contains characters we refuse to use in a request path.' });
      continue;
    }
    const swaggerUrl = props.apiDefinitions?.originalSwaggerUrl;
    if (!swaggerUrl) {
      out.push({ ...base, reason: `${displayName} has no published definition, so we cannot tell what it calls.` });
      continue;
    }

    try {
      // Never log or return swaggerUrl — it carries a SAS token.
      const swRes = await fetch(swaggerUrl);
      if (!swRes.ok) {
        out.push({ ...base, reason: `${displayName}'s definition could not be read (HTTP ${swRes.status}).` });
        continue;
      }
      const distilled = distilOriginalSwagger(id, displayName, (await swRes.json()) as Record<string, unknown>);
      if (!distilled) {
        out.push({ ...base, reason: `${displayName}'s definition declares no operations we can read.` });
        continue;
      }
      out.push({
        ...base,
        operationCount: distilled.index.operationCount,
        operations: Object.keys(distilled.index.operations).sort(),
        bindable: Boolean(distilled.index.vendorBinding),
        // `refusal` already explains the credential shape we cannot present; anything
        // else that got here is bindable and needs no reason.
        reason: distilled.refusal,
      });
    } catch (err) {
      out.push({ ...base, reason: `${displayName}'s definition could not be read: ${(err as Error).message}` });
    }
  }

  logger.info(
    { environmentId, total: rows.length, custom: custom.length, bindable: out.filter((c) => c.bindable).length },
    'custom connector inventory',
  );
  return out;
}
