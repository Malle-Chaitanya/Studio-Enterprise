import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { ConnectorOpIndex } from '../../connectors/operationBinding.js';

/**
 * Connector operation indexes captured from a CUSTOMER'S OWN Power Platform environment.
 *
 * The committed fixtures in `src/connectors/fixtures/` came from CloudFuze's environments.
 * This is a migration product: a customer installs a different set of connectors, sometimes
 * at different versions, so a fixture is at best a starting point and at worst a wrong
 * answer stated confidently. A connector we never captured currently reports "not yet
 * supported" even though its swagger is fetchable from the customer's environment with the
 * token we already mint.
 *
 * So indexes are captured on demand per environment and cached here. The fixtures remain as
 * an offline fallback and as what the unit tests assert against.
 *
 * SCOPE: keyed by `{scope, environmentId, connectorId}` where `scope` is
 * `credentialScope(session)` — a connector index is not secret, but it does reveal which
 * connectors a customer has installed, which is theirs and not another customer's business.
 *
 * Collection: connectorOpIndexes.
 */

const COLL = 'connectorOpIndexes';

export interface CachedOpIndex {
  scope: string;
  environmentId: string;
  connectorId: string;
  index: ConnectorOpIndex;
  capturedAt: Date;
}

export async function getCachedOpIndex(
  scope: string,
  environmentId: string,
  connectorId: string,
  maxAgeMs: number,
): Promise<ConnectorOpIndex | null> {
  if (!isDbConnected()) return null;
  try {
    const row = await getDb(config.CSGE_DB)
      .collection<CachedOpIndex>(COLL)
      .findOne({ scope, environmentId, connectorId });
    if (!row) return null;
    // A stale index is worse than none: it would describe operations against paths the
    // connector no longer has, and the failure would surface at inference as a 404 with
    // nothing pointing back here.
    if (Date.now() - new Date(row.capturedAt).getTime() > maxAgeMs) return null;
    return row.index;
  } catch (e) {
    logger.warn(`getCachedOpIndex read failed: ${(e as Error).message}`);
    return null;
  }
}

export async function putCachedOpIndex(
  scope: string,
  environmentId: string,
  connectorId: string,
  index: ConnectorOpIndex,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB)
      .collection<CachedOpIndex>(COLL)
      .updateOne(
        { scope, environmentId, connectorId },
        { $set: { scope, environmentId, connectorId, index, capturedAt: new Date() } },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`putCachedOpIndex persist failed: ${(e as Error).message}`);
  }
}
