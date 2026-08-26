import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { PurgeCount } from '../core.js';

/**
 * The last ELT sweep per tenant (collection: eltSweeps, one doc per appUserId).
 *
 * WHY THIS IS NOT JUST A MAP IN MEMORY. It was, and that made `GET /elt/status` lie in two
 * ordinary situations: after a restart or deploy it answered `last: null` for a tenant whose
 * agents had in fact been swept, and with more than one server instance it answered for
 * whichever one the request happened to reach. "No sweep has run" and "this process has not
 * seen the sweep that ran" are different facts, and only one of them is about the customer.
 *
 * Keyed by tenant as well as operator: one operator can connect several customer tenants,
 * and a single doc per operator meant each tenant's sweep record overwrote the last.
 *
 * IN-FLIGHT state stays in memory on purpose. It is a property of THIS process — the promise
 * being joined lives here — and persisting it would strand a `running: true` row forever if
 * the process died mid-sweep, which is exactly the false claim this collection exists to
 * remove.
 *
 * Best-effort like every other repo: a sweep that cannot record itself still swept.
 */

const COLL = 'eltSweeps';

export async function saveSweepResult(
  appUserId: string,
  tenantId: string,
  result: unknown,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { appUserId, tenantId },
      { $set: { appUserId, tenantId, result, savedAt: new Date() } },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`saveSweepResult failed: ${(e as Error).message}`);
  }
}

export async function getSweepResult<T>(
  appUserId: string,
  tenantId: string,
): Promise<T | null> {
  if (!isDbConnected()) return null;
  try {
    const doc = await getDb(config.CSGE_DB)
      .collection<{ result: T }>(COLL)
      .findOne({ appUserId, tenantId });
    return doc?.result ?? null;
  } catch (e) {
    logger.warn(`getSweepResult failed: ${(e as Error).message}`);
    return null;
  }
}

/** Part of the tenant purge — the sweep record names environments and agent counts. */
export async function purgeSweepResults(
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
