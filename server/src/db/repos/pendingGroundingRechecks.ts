import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { GeminiDestination } from '../../types.js';

/**
 * Discovery Engine's document import can finish importing well before the
 * content is actually searchable — indexing has been observed live to take
 * 6-10+ minutes past the point our upload+import call returns, longer than
 * any synchronous poll budget a migration request can reasonably block on.
 * Rather than permanently reporting a knowledge source as `lost` the moment
 * our poll window runs out, one row is recorded here so a background sweep
 * (services/groundingRecheck.ts) can confirm indexing later and, once it's
 * genuinely ready, automatically repoint the already-deployed agent at it —
 * no customer re-run, no manual repair script, ever required for this case.
 *
 * Collection: pendingGroundingRechecks (unique per {appUserId, envUrl,
 * sourceId, fileName}) — one row per knowledge file whose grounding attempt
 * timed out without a definitive success.
 */
export interface PendingGroundingRecheck {
  appUserId: string;
  envUrl: string;
  sourceId: string;
  project: string;
  engine: string;
  assistant: string;
  fileName: string;
  dataStoreId: string;
  attempts: number;
  nextCheckAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const COLL = 'pendingGroundingRechecks';

/** Upsert on (appUserId, envUrl, sourceId, fileName) — re-scheduling the same file replaces the pending row instead of piling up duplicates. */
export async function schedulePendingGroundingRecheck(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  dest: GeminiDestination,
  fileName: string,
  dataStoreId: string,
  nextCheckAt: Date,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    const now = new Date();
    await getDb(config.CSGE_DB)
      .collection<PendingGroundingRecheck>(COLL)
      .updateOne(
        { appUserId, envUrl, sourceId, fileName },
        {
          $set: { project: dest.project, engine: dest.engine, assistant: dest.assistant, dataStoreId, nextCheckAt, updatedAt: now },
          $setOnInsert: { appUserId, envUrl, sourceId, fileName, attempts: 0, createdAt: now },
        },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`schedulePendingGroundingRecheck persist failed: ${(e as Error).message}`);
  }
}

export async function getDuePendingGroundingRechecks(now: Date): Promise<PendingGroundingRecheck[]> {
  if (!isDbConnected()) return [];
  try {
    return await getDb(config.CSGE_DB)
      .collection<PendingGroundingRecheck>(COLL)
      .find({ nextCheckAt: { $lte: now } })
      .toArray();
  } catch (e) {
    logger.warn(`getDuePendingGroundingRechecks read failed: ${(e as Error).message}`);
    return [];
  }
}

export async function bumpPendingGroundingRecheck(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  fileName: string,
  nextCheckAt: Date,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB)
      .collection<PendingGroundingRecheck>(COLL)
      .updateOne({ appUserId, envUrl, sourceId, fileName }, { $inc: { attempts: 1 }, $set: { nextCheckAt, updatedAt: new Date() } });
  } catch (e) {
    logger.warn(`bumpPendingGroundingRecheck persist failed: ${(e as Error).message}`);
  }
}

export async function deletePendingGroundingRecheck(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  fileName: string,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection<PendingGroundingRecheck>(COLL).deleteOne({ appUserId, envUrl, sourceId, fileName });
  } catch (e) {
    logger.warn(`deletePendingGroundingRecheck persist failed: ${(e as Error).message}`);
  }
}
