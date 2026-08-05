import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * Tracks locally-uploaded files already grounded onto an ADK agent via a
 * Discovery Engine "document" data store, so re-running a migration reuses
 * the existing data store + import instead of re-uploading to GCS and
 * re-indexing the same file every run. One row per (customer, agent, file).
 *
 * Collection: adkKnowledgeStores (unique per {appUserId, sourceId, fileName}).
 */
export interface AdkKnowledgeStore {
  appUserId: string;
  sourceId: string; // source agent's Copilot Studio botid
  fileName: string;
  dataStoreId: string;
  resourcePath: string;
  status: 'done' | 'failed';
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLL = 'adkKnowledgeStores';

export async function getAdkKnowledgeStore(
  appUserId: string,
  sourceId: string,
  fileName: string,
): Promise<AdkKnowledgeStore | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB).collection<AdkKnowledgeStore>(COLL).findOne({ appUserId, sourceId, fileName });
  } catch (e) {
    logger.warn(`getAdkKnowledgeStore read failed: ${(e as Error).message}`);
    return null;
  }
}

/** Upsert on (appUserId, sourceId, fileName) — re-running for the same file updates in place. */
export async function upsertAdkKnowledgeStore(
  row: Omit<AdkKnowledgeStore, 'createdAt' | 'updatedAt'>,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    const now = new Date();
    const { appUserId, sourceId, fileName, ...rest } = row;
    await getDb(config.CSGE_DB)
      .collection<AdkKnowledgeStore>(COLL)
      .updateOne(
        { appUserId, sourceId, fileName },
        { $set: { ...rest, updatedAt: now }, $setOnInsert: { appUserId, sourceId, fileName, createdAt: now } },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`upsertAdkKnowledgeStore persist failed: ${(e as Error).message}`);
  }
}
