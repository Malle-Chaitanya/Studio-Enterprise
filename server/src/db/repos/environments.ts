import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * Cache of discovered environments + per-env inventory counts.
 * Collection: environmentsCache (unique {appUserId, tenantId}).
 *
 * Probing every environment's inventory is several Dataverse calls per env, so
 * we cache the computed list per tenant and reuse it within a short TTL. Both
 * the Explore and Migrate screens call GET /environments, so this avoids
 * re-probing the whole tenant on every page load.
 */

const COLL = 'environmentsCache';
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export interface EnvInfo {
  name: string;
  url: string;
  id: string;
  accessible: boolean;
  bots: number;
  topics: number;
  knowledgeSources: number;
  flows: number;
}

export async function getCachedEnvironments(
  appUserId: string,
  tenantId: string,
): Promise<EnvInfo[] | null> {
  if (!isDbConnected()) return null;
  try {
    const doc = await getDb(config.CSGE_DB)
      .collection<{ environments: EnvInfo[]; discoveredAt: Date }>(COLL)
      .findOne({ appUserId, tenantId });
    if (!doc) return null;
    if (Date.now() - new Date(doc.discoveredAt).getTime() > TTL_MS) return null;
    return doc.environments;
  } catch (e) {
    logger.warn(`getCachedEnvironments read failed: ${(e as Error).message}`);
    return null;
  }
}

export async function cacheEnvironments(
  appUserId: string,
  tenantId: string,
  environments: EnvInfo[],
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { appUserId, tenantId },
      { $set: { appUserId, tenantId, environments, discoveredAt: new Date() } },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`cacheEnvironments persist failed: ${(e as Error).message}`);
  }
}
