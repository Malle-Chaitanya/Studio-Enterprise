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
    if (doc) return doc.snapshot;

    // Same project, two spellings — the ID (`studio-enterprise-migration`) and the NUMBER
    // (`231705905417`) — depending on which path resolved the destination. adkDeployments
    // already carries this fallback; this repo did not, so a run could FIND the deployment
    // record and then MISS its snapshot, which reads as "migrated before drift-tracking
    // existed" and returns early as `already exists`.
    //
    // That is exactly how a deleted agent got reported as still migrated (live 2026-08-13):
    // the early return fires before any check of whether the agent is still there. The
    // engine id is unique to one project, so matching without `project` is safe, and it
    // stays a FALLBACK so an exact record still wins.
    const byEngine = await getDb(config.CSGE_DB)
      .collection(COLL)
      .find<{ snapshot: DriftSnapshot; savedAt?: Date }>({ appUserId, envUrl, sourceId, engine: dest.engine })
      .sort({ savedAt: -1 })
      .limit(1)
      .next();
    if (byEngine) {
      logger.info(
        { sourceId, engine: dest.engine },
        'migratedAgentSnapshots: matched by engine — the project was recorded under a different spelling',
      );
      return byEngine.snapshot;
    }
    return null;
  } catch (e) {
    logger.warn(`getMigratedSnapshot read failed: ${(e as Error).message}`);
    return null;
  }
}
