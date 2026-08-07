import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * Tracks locally-uploaded files already grounded onto an ADK agent via a
 * Discovery Engine "document" data store, so re-running a migration reuses
 * the existing data store + import instead of re-uploading to GCS and
 * re-indexing the same file every run. One row per (customer, agent, file).
 *
 * Collection: adkKnowledgeStores (unique per {appUserId, project, sourceId, fileName}).
 *
 * `project` is part of the key because a data store only exists in ONE Google project,
 * and the Reasoning Engine's service agent only has Discovery Engine access in the
 * project the agent was deployed to. Without it, a store created while targeting one
 * project was reused when deploying to another, and every retrieval failed at query time
 * with `403 discoveryengine.servingConfigs.search denied` — while the migration still
 * reported deployed/verified. Observed live 2026-08-07.
 */
export interface AdkKnowledgeStore {
  appUserId: string;
  /** Google project the data store lives in — a store is not portable across projects. */
  project: string;
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
  project: string,
): Promise<AdkKnowledgeStore | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB).collection<AdkKnowledgeStore>(COLL).findOne({ appUserId, project, sourceId, fileName });
  } catch (e) {
    logger.warn(`getAdkKnowledgeStore read failed: ${(e as Error).message}`);
    return null;
  }
}

/** Upsert on (appUserId, project, sourceId, fileName) — re-running updates in place. */
export async function upsertAdkKnowledgeStore(
  row: Omit<AdkKnowledgeStore, 'createdAt' | 'updatedAt'>,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    const now = new Date();
    const { appUserId, project, sourceId, fileName, ...rest } = row;
    await getDb(config.CSGE_DB)
      .collection<AdkKnowledgeStore>(COLL)
      .updateOne(
        { appUserId, project, sourceId, fileName },
        { $set: { ...rest, updatedAt: now }, $setOnInsert: { appUserId, project, sourceId, fileName, createdAt: now } },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`upsertAdkKnowledgeStore persist failed: ${(e as Error).message}`);
  }
}
