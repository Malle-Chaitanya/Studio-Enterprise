import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { PurgeCount } from '../core.js';

/**
 * The source tenant's mappable users, snapshotted when the clouds connect
 * (collection: sourceUsers, one doc per appUserId + tenantId).
 *
 * WHY. Map users read this list live from Graph on every mount — 3.6s, and paid again every
 * time someone stepped back through the wizard. The list is the same licensed directory the
 * ELT sweep is already in a position to fetch, so it is fetched once at connect alongside the
 * agents and read from Mongo thereafter.
 *
 * Deliberately the WHOLE filtered list, not a derived subset: the screen decides what to show
 * and in what order, and a repo that pre-judged that would have to change every time the
 * screen's mind did.
 *
 * Freshness is explicit, not assumed. `capturedAt` rides along so the screen can say how old
 * the list is, and Rescan re-runs the sweep — an offboarded account offered as a mapping
 * target is a real error, so staleness has to be visible rather than silently tolerated.
 */

const COLL = 'sourceUsers';

export interface SourceUserBrief {
  id: string;
  email: string;
  displayName?: string;
  userPrincipalName?: string;
}

export interface SourceUserSnapshot {
  users: SourceUserBrief[];
  /** The server's own account of why the list is this length — shown, never recomputed. */
  filter?: Record<string, unknown>;
  truncated?: boolean;
  capturedAt: Date;
}

export async function saveSourceUsers(
  appUserId: string,
  tenantId: string,
  snapshot: Omit<SourceUserSnapshot, 'capturedAt'>,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { appUserId, tenantId },
      { $set: { appUserId, tenantId, ...snapshot, capturedAt: new Date() } },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`saveSourceUsers failed: ${(e as Error).message}`);
  }
}

export async function getSourceUsers(
  appUserId: string,
  tenantId: string,
): Promise<SourceUserSnapshot | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB)
      .collection<SourceUserSnapshot>(COLL)
      .findOne({ appUserId, tenantId }, { projection: { _id: 0 } });
  } catch (e) {
    logger.warn(`getSourceUsers failed: ${(e as Error).message}`);
    return null;
  }
}

/** Part of the tenant purge — this is customer directory data. */
export async function purgeSourceUsers(
  appUserId: string,
  tenantId?: string,
): Promise<PurgeCount> {
  if (!isDbConnected()) throw new Error('database not connected — purge not attempted');
  const coll = getDb(config.CSGE_DB).collection(COLL);
  const scope = tenantId ? { appUserId, tenantId } : { appUserId };
  const r = await coll.deleteMany(scope);
  // Left behind ON PURPOSE when purging one tenant: a row with no tenant could belong to any
  // customer this operator has connected. Reported so the caller can say so.
  const untagged = tenantId
    ? await coll.countDocuments({ appUserId, tenantId: { $exists: false } })
    : 0;
  return { deleted: r.deletedCount ?? 0, untagged };
}
