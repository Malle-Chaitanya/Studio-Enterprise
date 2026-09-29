import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { ConnectorOpIndex, OpIndexParameter } from '../../connectors/operationBinding.js';

/**
 * The clean, normalized connector registry — two collections, replacing the earlier
 * single-blob `connectorCatalog` pilot:
 *
 *   connectors           — one row per connector: identity + auth facts only.
 *   connectorOperations  — one row PER OPERATION, so operations are searchable and
 *                          indexable across every connector, not buried inside a
 *                          nested map field on one document.
 *
 * Not customer data: a connector's own operation list and auth shape are the same
 * fact for every customer who has it, so neither collection carries appUserId/scope —
 * same treatment as the committed swagger fixtures already receive.
 */

const CONNECTORS = 'connectors';
const OPERATIONS = 'connectorOperations';

export interface ConnectorAuth {
  /** e.g. 'oauth2', 'apiKey', 'basic' — taken from the connector's own securityDefinitions. */
  type?: string;
  identityProvider?: string;
  /** The AAD/OAuth resource this connector's tokens are minted against, if applicable. */
  resource?: string;
  scopes?: string[];
}

export interface ConnectorRecord {
  connectorId: string;
  displayName: string;
  publisher: string;
  /** True only for connectors whose real underlying SERVICE is Microsoft's own —
   *  not merely connectors Microsoft happens to have published a wrapper for. */
  isMicrosoftOwnService: boolean;
  category?: string;
  proxyHost?: string;
  proxyBasePath?: string;
  /**
   * The FULL real auth map, one entry per connection parameter Microsoft's own
   * definition declares — never collapsed to "just one". A connector can need more
   * than a credential: Zendesk needs a plain subdomain field AND an OAuth token, as
   * two separate entries here, keyed exactly as Microsoft names them
   * ('token:SubDomain', 'token'). Picking only one silently discarded whichever
   * wasn't chosen — confirmed live on Zendesk, where the plain subdomain field was
   * picked over the real OAuth entry and its real scope ('read write') was lost.
   */
  authParameters: Record<string, ConnectorAuth>;
  /** Convenience only, derived from authParameters by picking the real oauthSetting
   *  entry (never the first one blindly) — authParameters remains the source of truth. */
  primaryAuth?: ConnectorAuth;
  operationCount: number;
  capturedAt: Date;
  capturedFrom: string;
}

export interface ConnectorOperationRecord {
  connectorId: string;
  operationId: string;
  method: string;
  path: string;
  summary: string;
  parameters: OpIndexParameter[];
  deprecated?: boolean;
}

export async function putConnector(rec: ConnectorRecord): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB)
      .collection<ConnectorRecord>(CONNECTORS)
      // $unset the retired single-entry `auth` field left behind by documents written
      // before the authParameters/primaryAuth schema — otherwise it lingers stale forever.
      .updateOne({ connectorId: rec.connectorId }, { $set: rec, $unset: { auth: '' } }, { upsert: true });
  } catch (e) {
    logger.warn(`putConnector failed: ${(e as Error).message}`);
  }
}

/** Replaces ALL operations for this connector with the given set — never leaves stale
 *  rows behind from a previous, since-changed capture. */
export async function putConnectorOperations(
  connectorId: string,
  ops: ConnectorOperationRecord[],
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    const coll = getDb(config.CSGE_DB).collection<ConnectorOperationRecord>(OPERATIONS);
    await coll.deleteMany({ connectorId });
    if (ops.length) await coll.insertMany(ops);
  } catch (e) {
    logger.warn(`putConnectorOperations failed: ${(e as Error).message}`);
  }
}

export async function listConnectors(): Promise<ConnectorRecord[]> {
  if (!isDbConnected()) return [];
  return getDb(config.CSGE_DB).collection<ConnectorRecord>(CONNECTORS).find({}).sort({ displayName: 1 }).toArray();
}

export async function getConnector(connectorId: string): Promise<ConnectorRecord | undefined> {
  if (!isDbConnected()) return undefined;
  const rec = await getDb(config.CSGE_DB).collection<ConnectorRecord>(CONNECTORS).findOne({ connectorId });
  return rec ?? undefined;
}

/** Connector ids whose stored capture is older than `cutoff` — what the freshness
 *  sweep (services/connectorRegistryRefresh.ts) treats as due for a live re-check. */
export async function listConnectorIdsOlderThan(cutoff: Date): Promise<string[]> {
  if (!isDbConnected()) return [];
  const rows = await getDb(config.CSGE_DB)
    .collection<ConnectorRecord>(CONNECTORS)
    .find({ capturedAt: { $lt: cutoff } }, { projection: { connectorId: 1 } })
    .toArray();
  return rows.map((r) => r.connectorId);
}

export async function listOperationsFor(connectorId: string): Promise<ConnectorOperationRecord[]> {
  if (!isDbConnected()) return [];
  return getDb(config.CSGE_DB)
    .collection<ConnectorOperationRecord>(OPERATIONS)
    .find({ connectorId })
    .sort({ operationId: 1 })
    .toArray();
}

/**
 * The reverse of `toRegistryRecords`: reconstruct a ConnectorOpIndex from what's stored,
 * for `resolveOpIndex` to hand back to the exact same binding pipeline every other source
 * (cache, live capture, fixture) already feeds. `securityDefinitions` is not preserved
 * (not stored) — safe, since real binding reads `connectionAuth`/`proxyHost`/operations,
 * not that field.
 */
export async function loadFromRegistry(connectorId: string): Promise<ConnectorOpIndex | undefined> {
  if (!isDbConnected()) return undefined;
  const connector = await getDb(config.CSGE_DB)
    .collection<ConnectorRecord>(CONNECTORS)
    .findOne({ connectorId });
  if (!connector) return undefined;
  const ops = await listOperationsFor(connectorId);
  if (!ops.length) return undefined;

  const operations: ConnectorOpIndex['operations'] = {};
  for (const op of ops) {
    operations[op.operationId] = {
      method: op.method,
      path: op.path,
      summary: op.summary,
      deprecated: op.deprecated,
      parameters: op.parameters,
    };
  }

  return {
    connectorId: connector.connectorId,
    displayName: connector.displayName,
    proxyHost: connector.proxyHost ?? '',
    proxyBasePath: connector.proxyBasePath ?? '',
    securityDefinitions: {},
    connectionAuth: connector.authParameters ?? {},
    operationCount: connector.operationCount,
    operations,
  };
}

/** Pick the real OAuth credential entry out of a multi-entry auth map — never just the
 *  first one. Confirmed necessary live: Zendesk's map has 'token:SubDomain' (a plain
 *  string field) listed before 'token' (the real oauthSetting entry, scope 'read write'),
 *  and taking the first blindly silently reported the connector as having no real scope. */
function pickPrimaryAuth(authMap: Record<string, ConnectorAuth>): ConnectorAuth | undefined {
  const entries = Object.values(authMap);
  return entries.find((e) => e.type === 'oauthSetting') ?? entries[0];
}

/** Turn a live-captured ConnectorOpIndex into the two record shapes this registry stores. */
export function toRegistryRecords(
  connectorId: string,
  publisher: string,
  isMicrosoftOwnService: boolean,
  category: string,
  index: ConnectorOpIndex,
): { connector: ConnectorRecord; operations: ConnectorOperationRecord[] } {
  const authParameters = index.connectionAuth ?? {};

  const operations: ConnectorOperationRecord[] = Object.entries(index.operations ?? {}).map(
    ([operationId, op]) => ({
      connectorId,
      operationId,
      method: op.method,
      path: op.path,
      summary: op.summary ?? '',
      parameters: op.parameters ?? [],
      deprecated: op.deprecated,
    }),
  );

  return {
    connector: {
      connectorId,
      displayName: index.displayName || connectorId,
      publisher,
      isMicrosoftOwnService,
      category,
      proxyHost: index.proxyHost,
      proxyBasePath: index.proxyBasePath,
      authParameters,
      primaryAuth: pickPrimaryAuth(authParameters),
      operationCount: index.operationCount,
      capturedAt: new Date(),
      capturedFrom: 'live-capture',
    },
    operations,
  };
}
