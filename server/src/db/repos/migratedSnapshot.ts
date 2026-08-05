import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { GeminiDestination } from '../../types.js';
import type { DriftSnapshot } from '../../services/driftDetector.js';

/**
 * Snapshot of the last CONFIRMED SUCCESSFUL sync for a source agent — separate
 * from `agentIRCache` on purpose. `agentIRCache` is overwritten unconditionally
 * every Phase-1 extraction (before Phase 2 ever runs), so it can never answer
 * "what did we last actually migrate" — by the time Phase 2 would compare, the
 * cache already holds THIS run's fresh IR. This collection is written only
 * when a sync genuinely succeeds (fresh create, or a drift-triggered
 * redeploy), so the next re-run has something real to diff against.
 *
 * Collection: migratedAgentSnapshots (unique per {appUserId, envUrl, sourceId, project, engine}).
 */

const COLL = 'migratedAgentSnapshots';

export async function saveMigratedSnapshot(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  dest: GeminiDestination,
  snapshot: DriftSnapshot,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { appUserId, envUrl, sourceId, project: dest.project, engine: dest.engine },
      { $set: { appUserId, envUrl, sourceId, project: dest.project, engine: dest.engine, snapshot, syncedAt: new Date() } },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`saveMigratedSnapshot persist failed: ${(e as Error).message}`);
  }
}

export async function getMigratedSnapshot(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  dest: GeminiDestination,
): Promise<DriftSnapshot | null> {
  if (!isDbConnected()) return null;
  try {
    const doc = await getDb(config.CSGE_DB)
      .collection(COLL)
      .findOne<{ snapshot: DriftSnapshot }>({ appUserId, envUrl, sourceId, project: dest.project, engine: dest.engine });
    return doc?.snapshot ?? null;
  } catch (e) {
    logger.warn(`getMigratedSnapshot read failed: ${(e as Error).message}`);
    return null;
  }
}
