/**
 * Capture a connector's operation index from the CUSTOMER'S Power Platform environment.
 *
 * The swagger for a connector is served per environment:
 *
 *   GET https://api.powerapps.com/providers/Microsoft.PowerApps/apis/<connectorId>
 *       ?api-version=2016-11-01&$filter=environment eq '<envId>'&$expand=swagger
 *
 * with the `https://service.powerapps.com` audience — an app-only token we already mint, no
 * extra admin consent (proven live 2026-08-12, ledger §1.11).
 *
 * Reading it from the customer's own environment rather than shipping one capture of ours is
 * what makes the readiness answer true for THEM: they install a different set of connectors,
 * sometimes at different versions, and a connector we never captured would otherwise be
 * reported "not yet supported" when its API is right there.
 *
 * Read-only against Power Apps: one GET, no writes, nothing created.
 */
import { logger } from '../logger.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { loadOpIndex } from './opIndex.js';
import { getCachedOpIndex, putCachedOpIndex } from '../db/repos/connectorOpIndex.js';
import type { ConnectorOpIndex, OpIndexOperation, OpIndexParameter, VendorAuth } from './operationBinding.js';

export const POWERAPPS_AUDIENCE = 'https://service.powerapps.com';
/** A connector's shape changes rarely; a fortnight keeps us current without re-fetching per run. */
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

/** Distil the Power Apps swagger into the index shape. Mirrors spikes/_dump_connector_op_index.ts. */
function distil(connectorId: string, body: Record<string, unknown>): ConnectorOpIndex | null {
  const props = (body.properties ?? {}) as Record<string, unknown>;
  const sw = (props.swagger ?? {}) as Record<string, unknown>;
  const paths = (sw.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  const operations: Record<string, OpIndexOperation> = {};
  for (const [path, verbs] of Object.entries(paths)) {
    for (const [verb, op] of Object.entries(verbs ?? {})) {
      const operationId = op?.operationId as string | undefined;
      if (!operationId) continue;
      operations[operationId] = {
        method: verb.toUpperCase(),
        path,
        summary: (op.summary as string) ?? '',
        parameters: ((op.parameters as Array<Record<string, unknown>>) ?? []).map((p): OpIndexParameter => ({
          name: String(p.name ?? ''),
          in: (p.in as OpIndexParameter['in']) ?? 'query',
          required: p.required === true,
          type: (p.type as string) ?? ((p.schema as { type?: string })?.type ?? 'object'),
          visibility: (p['x-ms-visibility'] as string) ?? undefined,
        })),
      };
    }
  }
  if (!Object.keys(operations).length) return null;

  // Only the auth-SHAPING half of connectionParameters — what kind of credential the vendor
  // wants. Never a credential value; nothing here is secret or customer-specific.
  const cp = (props.connectionParameters ?? {}) as Record<string, Record<string, unknown>>;
  const connectionAuth: ConnectorOpIndex['connectionAuth'] = {};
  for (const [key, val] of Object.entries(cp)) {
    const oauth = (val?.oAuthSettings ?? {}) as Record<string, unknown>;
    const custom = (oauth.customParameters ?? {}) as Record<string, { value?: string }>;
    const oauthProps = (oauth.properties ?? {}) as Record<string, string>;
    connectionAuth[key] = {
      type: val?.type as string | undefined,
      identityProvider: oauth.identityProvider as string | undefined,
      resource:
        custom.resourceUriAAD?.value ??
        custom.ResourceUriAAD?.value ??
        oauthProps.AzureActiveDirectoryResourceId,
      scopes: oauth.scopes as string[] | undefined,
    };
  }

  return {
    connectorId,
    displayName: (props.displayName as string) ?? connectorId,
    proxyHost: (sw.host as string) ?? '',
    proxyBasePath: (sw.basePath as string) ?? '',
    securityDefinitions: (sw.securityDefinitions as Record<string, unknown>) ?? {},
    connectionAuth,
    operationCount: Object.keys(operations).length,
    operations,
  };
}

/**
 * Ids come from customer-controlled Dataverse payloads and are used in a URL and a file
 * path, so they are whitelisted rather than escaped. Hyphens must be allowed: a custom
 * connector is named after its display name with the spaces percent-encoded, so "Get CRM
 * objects from Hubspot" is `shared_get-20crm-20objects-20from-20hubspot-5fdd816392-…`.
 * Rejecting it meant every custom connector was unresolvable regardless of permissions.
 * `.`, `/` and `\` remain excluded, so no hyphen can traverse anywhere.
 */
export const SAFE_CONNECTOR_ID = /^[a-z0-9_-]+$/i;

/**
 * Turn a connector's ORIGINAL swagger into an index plus the binding it implies.
 *
 * This is a different document from the Power Apps proxy swagger `distil()` reads. The
 * proxy version prefixes every path with `{connectionId}` and is hosted on an
 * `azure-apihub.net` APIM front door; the original is what the author uploaded, so its
 * host IS the vendor and its paths ARE the vendor's paths:
 *
 *     host api.hubapi.com   basePath /   schemes https
 *     GetDeals   GET /crm/v3/objects/deals
 *
 * That is everything a bound call needs, plus the operation summaries — which matter more
 * than they look: a Copilot tool's Description is NOT stored on the agent (verified across
 * every component of "Hubspot agentt"), so the swagger is the only source of the text the
 * model routes on. Recreating the tools without it produces four tools the model cannot
 * tell apart.
 */
export function distilOriginalSwagger(
  connectorId: string,
  displayName: string,
  sw: Record<string, unknown>,
): { index: ConnectorOpIndex; refusal?: string } | null {
  const paths = (sw.paths ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
  const operations: Record<string, OpIndexOperation> = {};
  for (const [path, verbs] of Object.entries(paths)) {
    for (const [verb, op] of Object.entries(verbs ?? {})) {
      const operationId = op?.operationId as string | undefined;
      if (!operationId) continue;
      operations[operationId] = {
        method: verb.toUpperCase(),
        path,
        // `description` before `summary`, and deliberately so. In a custom connector's
        // definition the two carry the two halves of what Copilot Studio shows in Tool
        // details — summary is the NAME ("Get deals"), description is the DESCRIPTION
        // ("Retrieve a list of HubSpot deals"). The description is the text the model
        // routes on, and it is the one thing the agent itself does not store, so taking
        // the summary instead would rebuild four tools the model cannot tell apart.
        summary: (op.description as string) || (op.summary as string) || '',
        parameters: ((op.parameters as Array<Record<string, unknown>>) ?? []).map((p): OpIndexParameter => ({
          name: String(p.name ?? ''),
          in: (p.in as OpIndexParameter['in']) ?? 'query',
          required: p.required === true,
          type: (p.type as string) ?? ((p.schema as { type?: string })?.type ?? 'object'),
          visibility: (p['x-ms-visibility'] as string) ?? undefined,
        })),
      };
    }
  }
  if (!Object.keys(operations).length) return null;

  const host = String(sw.host ?? '');
  if (!host) return null;
  const schemes = (sw.schemes as string[]) ?? ['https'];
  const basePath = String(sw.basePath ?? '').replace(/\/$/, '');
  const secDefs = (sw.securityDefinitions ?? {}) as Record<
    string,
    { type?: string; in?: string; name?: string }
  >;

  // Only credential shapes we can actually present. Anything else is refused BY NAME
  // rather than bound with a guessed header: a tool that authenticates wrongly fails at
  // run time with a vendor error the customer cannot trace back to us.
  let auth: VendorAuth | undefined;
  let refusal: string | undefined;
  const defs = Object.values(secDefs);
  const apiKeyAuthHeader = defs.find(
    (d) => d.type === 'apiKey' && d.in === 'header' && /^authorization$/i.test(d.name ?? ''),
  );
  if (apiKeyAuthHeader) {
    auth = 'bearer-token';
  } else if (defs.length === 0) {
    refusal = `${displayName} publishes no security definition, so we cannot tell what credential it expects.`;
  } else {
    const kinds = defs.map((d) => `${d.type ?? '?'}${d.in ? ` in ${d.in}` : ''}${d.name ? ` (${d.name})` : ''}`);
    refusal =
      `${displayName} authenticates with ${kinds.join(', ')}, which this version can only reproduce for ` +
      'an API key sent as an Authorization header.';
  }

  const index: ConnectorOpIndex = {
    connectorId,
    displayName,
    proxyHost: host,
    proxyBasePath: basePath,
    securityDefinitions: secDefs,
    connectionAuth: {},
    operationCount: Object.keys(operations).length,
    operations,
    vendorBinding: auth
      ? { baseUrl: `${schemes.includes('https') ? 'https' : schemes[0]}://${host}${basePath}`, pathStyle: 'vendor-path', auth }
      : undefined,
  };
  return { index, refusal };
}

export interface CaptureContext {
  /** Entra tenant id — the token audience is minted against it. */
  tenantId: string;
  /** Power Platform environment id (the GUID from environment discovery, not the org URL). */
  environmentId: string;
  /** Customer isolation key — `credentialScope(session)`. */
  scope: string;
}

/**
 * The operation index for one connector, freshest source first:
 *   1. this customer's cached capture (≤14 days old)
 *   2. a live capture from their environment, cached on success
 *   3. the committed fixture, as an offline fallback
 *
 * Returns undefined when none of the three has it — which the caller reports as "not yet
 * supported", never as "will fail".
 */
export async function resolveOpIndex(
  connectorId: string,
  ctx: CaptureContext | undefined,
): Promise<ConnectorOpIndex | undefined> {
  if (ctx) {
    const cached = await getCachedOpIndex(ctx.scope, ctx.environmentId, connectorId, CACHE_TTL_MS);
    if (cached) return cached;
    const live = await captureOpIndex(connectorId, ctx);
    if (live) return live;
    // The user-scope GET above answers 403 ApiAuthorizationFailed for a CUSTOM connector
    // our app was never shared on. That reads like a locked door and is not one — the
    // admin scope we already hold lists the same connector and carries the route to its
    // definition. Trying it second costs one request on the path that was returning
    // nothing anyway.
    const custom = await captureCustomConnector(connectorId, ctx);
    if (custom) return custom;
  }
  // The fixture is a different tenant's capture of the same connector. Fine as a fallback —
  // the operations of `shared_confluence` are Microsoft's, not ours — but it is the third
  // choice, not the first, because a customer's environment can hold a different version.
  return loadOpIndex(connectorId);
}

/** One live capture. Returns undefined on any failure — never throws into a migration. */
export async function captureOpIndex(
  connectorId: string,
  ctx: CaptureContext,
): Promise<ConnectorOpIndex | undefined> {
  if (!SAFE_CONNECTOR_ID.test(connectorId)) return undefined; // ids come from customer payloads
  try {
    const token = await clientCredsToken(ctx.tenantId, POWERAPPS_AUDIENCE);
    const url =
      `https://api.powerapps.com/providers/Microsoft.PowerApps/apis/${encodeURIComponent(connectorId)}` +
      `?api-version=2016-11-01&$filter=${encodeURIComponent(`environment eq '${ctx.environmentId}'`)}&$expand=swagger`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      // 404 here means "not installed in this environment", which is information, not an
      // error — it is why the customer's own capture is the right source.
      logger.debug({ connectorId, status: res.status }, 'connector swagger not available in this environment');
      return undefined;
    }
    const index = distil(connectorId, (await res.json()) as Record<string, unknown>);
    if (!index) return undefined;
    await putCachedOpIndex(ctx.scope, ctx.environmentId, connectorId, index);
    logger.info({ connectorId, ops: index.operationCount }, 'captured connector operation index from customer environment');
    return index;
  } catch (err) {
    logger.warn({ connectorId, err: (err as Error).message }, 'connector index capture failed');
    return undefined;
  }
}

/**
 * Capture a CUSTOM connector from the admin scope, which needs no per-connector sharing.
 *
 * The user-scope endpoint refuses a connector our app was never shared on:
 *
 *     GET .../providers/Microsoft.PowerApps/apis/{id}?$expand=properties/swagger
 *     403 ApiAuthorizationFailed — "The caller … does not have permission to custom
 *         connector 'shared_get-20crm-20objects-20from-20hubspot-…'"
 *
 * Asking the customer to share each connector was the obvious response and the wrong one:
 * a customer with twenty custom connectors would face twenty grants before a migration
 * could run. The admin scope our app already holds returns the same connector (200), and
 * although the swagger is never inline there, the row carries
 * `apiDefinitions.originalSwaggerUrl` — a blob URL that fetches clean and holds the real
 * vendor definition. Measured 2026-08-12: four HubSpot operations, host api.hubapi.com.
 *
 * The blob URL carries a SAS token in its query string, so it is never logged.
 *
 * Returns undefined on any failure — a capture that does not work must leave the operation
 * reported as unsupported, never fail the migration.
 */
export async function captureCustomConnector(
  connectorId: string,
  ctx: CaptureContext,
): Promise<ConnectorOpIndex | undefined> {
  if (!SAFE_CONNECTOR_ID.test(connectorId)) return undefined;
  try {
    const token = await clientCredsToken(ctx.tenantId, POWERAPPS_AUDIENCE);
    const listUrl =
      `https://api.powerapps.com/providers/Microsoft.PowerApps/scopes/admin` +
      `/environments/${encodeURIComponent(ctx.environmentId)}/apis?api-version=2016-11-01`;
    const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      logger.debug({ status: res.status }, 'admin custom-connector listing unavailable');
      return undefined;
    }
    const rows = ((await res.json()) as {
      value?: Array<{ name?: string; properties?: Record<string, unknown> }>;
    }).value ?? [];
    const row = rows.find((r) => (r.name ?? '').toLowerCase() === connectorId.toLowerCase());
    if (!row) return undefined;

    const props = row.properties ?? {};
    const displayName = String(props.displayName ?? connectorId);
    const swaggerUrl = (props.apiDefinitions as { originalSwaggerUrl?: string } | undefined)?.originalSwaggerUrl;
    if (!swaggerUrl) {
      logger.debug({ connectorId }, 'custom connector has no published definition');
      return undefined;
    }

    const swRes = await fetch(swaggerUrl);
    if (!swRes.ok) {
      // Never log swaggerUrl — it carries a SAS token.
      logger.debug({ connectorId, status: swRes.status }, 'custom connector definition not retrievable');
      return undefined;
    }
    const distilled = distilOriginalSwagger(
      connectorId,
      displayName,
      (await swRes.json()) as Record<string, unknown>,
    );
    if (!distilled) return undefined;

    // Policies rewrite the request before it reaches the backend. We reproduce the
    // definition, not the policies, so carry the count rather than silently assuming zero.
    const policies = (props.policyTemplateInstances as unknown[] | undefined)?.length ?? 0;
    const index: ConnectorOpIndex = { ...distilled.index, policyCount: policies };

    if (distilled.refusal) {
      // No vendorBinding, so bindOperation returns `unknown-connector` with its own
      // reason. Cache it anyway: knowing the operations exist is what lets the readiness
      // pass name them instead of reporting the whole connector as simply unknown.
      logger.info({ connectorId, reason: distilled.refusal }, 'custom connector captured but not bindable');
    }
    await putCachedOpIndex(ctx.scope, ctx.environmentId, connectorId, index);
    logger.info(
      { connectorId, displayName, ops: index.operationCount, policies, bindable: Boolean(index.vendorBinding) },
      'captured CUSTOM connector definition from the admin scope',
    );
    return index;
  } catch (err) {
    logger.warn({ connectorId, err: (err as Error).message }, 'custom connector capture failed');
    return undefined;
  }
}
