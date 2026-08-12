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
import type { ConnectorOpIndex, OpIndexOperation, OpIndexParameter } from './operationBinding.js';

const POWERAPPS_AUDIENCE = 'https://service.powerapps.com';
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
  if (!/^[a-z0-9_]+$/i.test(connectorId)) return undefined; // ids come from customer payloads
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
