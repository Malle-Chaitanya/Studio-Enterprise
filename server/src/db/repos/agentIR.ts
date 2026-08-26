import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { PurgeCount } from '../core.js';
import type { AgentIR, MappedAgent } from '../../types.js';

/**
 * Cache of extracted AgentIR + MappedAgent per source agent.
 * Collection: agentIRCache (unique {appUserId, envUrl, sourceId}).
 *
 * Purpose: audit trail + skip re-extraction from Dataverse on re-runs. The IR is
 * the expensive-to-produce, platform-neutral heart of the pipeline (see
 * types.ts), so it's worth persisting.
 *
 * Rows also carry `tenantId`. `envUrl` already implies a tenant, but only to someone who
 * can still resolve it — a purge cannot go asking Dataverse which environments belonged to
 * which customer, so the tenant has to be written down at capture time. Rows written before
 * this field existed carry no tenant and a tenant-scoped purge leaves them alone rather than
 * risk deleting another customer's IR; `purgeCachedIR` reports how many.
 */

const COLL = 'agentIRCache';

export async function cacheAgentIR(
  appUserId: string,
  envUrl: string,
  ir: AgentIR,
  mapped: MappedAgent,
  tenantId?: string,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { appUserId, envUrl, sourceId: ir.sourceId },
      {
        $set: {
          appUserId, envUrl, sourceId: ir.sourceId, ir, mapped, extractedAt: new Date(),
          ...(tenantId ? { tenantId } : {}),
        },
      },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`cacheAgentIR persist failed: ${(e as Error).message}`);
  }
}

export async function getCachedIR(
  appUserId: string,
  envUrl: string,
  sourceId: string,
): Promise<{ ir: AgentIR; mapped: MappedAgent } | null> {
  if (!isDbConnected()) return null;
  try {
    const doc = await getDb(config.CSGE_DB)
      .collection(COLL)
      .findOne<{ ir: AgentIR; mapped: MappedAgent }>({ appUserId, envUrl, sourceId });
    return doc ? { ir: doc.ir, mapped: doc.mapped } : null;
  } catch (e) {
    logger.warn(`getCachedIR read failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * Land an extracted IR that has NOT been mapped yet — the T of the ELT sweep.
 *
 * Separate from `cacheAgentIR` because the two say different things. That one records
 * "this agent was extracted AND mapped during a run"; this one records "this agent exists
 * in the source and here is its IR", which is all a connect-time sweep can honestly claim.
 * Writing a fabricated `mapped` to reuse the other function would make a later reader
 * believe a mapping had been computed when none had.
 *
 * `mapped` is deliberately ABSENT from the `$set`, not set to undefined: an upsert that
 * listed it would blank a real mapping a migration run had already written for this agent.
 * Omitting the field leaves whatever is there untouched, so a sweep refreshes the IR and
 * nothing else.
 */
export async function cacheExtractedIR(
  appUserId: string,
  envUrl: string,
  ir: AgentIR,
  opts: { tenantId?: string; source?: 'elt-sweep' | 'run' } = {},
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { appUserId, envUrl, sourceId: ir.sourceId },
      {
        $set: {
          appUserId, envUrl, sourceId: ir.sourceId, ir, extractedAt: new Date(),
          source: opts.source ?? 'elt-sweep',
          ...(opts.tenantId ? { tenantId: opts.tenantId } : {}),
        },
      },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`cacheExtractedIR persist failed: ${(e as Error).message}`);
  }
}

/** Every IR held for one tenant, newest first. Tenant-scoped by construction. */
export async function listCachedIR(
  appUserId: string,
  envUrl?: string,
): Promise<Array<{ envUrl: string; sourceId: string; ir: AgentIR; extractedAt?: Date }>> {
  if (!isDbConnected()) return [];
  try {
    const filter: Record<string, unknown> = { appUserId };
    if (envUrl) filter.envUrl = envUrl;
    return await getDb(config.CSGE_DB)
      .collection<{ envUrl: string; sourceId: string; ir: AgentIR; extractedAt?: Date }>(COLL)
      .find(filter, { projection: { _id: 0, envUrl: 1, sourceId: 1, ir: 1, extractedAt: 1 } })
      .sort({ extractedAt: -1 })
      .toArray();
  } catch (e) {
    logger.warn(`listCachedIR failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * Delete every cached IR for one tenant, and say how many went.
 *
 * Pairs with `purgeRawAgents`. Purging only the raw payloads would leave the SAME customer
 * content sitting here in parsed form — instructions, topics, knowledge sources — while the
 * caller reported the data deleted. A deletion that is only partly true is worse than one
 * that refuses. Throws for the same reason `purgeRawAgents` does.
 */
export async function purgeCachedIR(
  appUserId: string,
  tenantId?: string,
): Promise<PurgeCount> {
  if (!isDbConnected()) throw new Error('database not connected — purge not attempted');
  const coll = getDb(config.CSGE_DB).collection(COLL);
  const scope = tenantId ? { appUserId, tenantId } : { appUserId };
  const r = await coll.deleteMany(scope);
  const untagged = tenantId
    ? await coll.countDocuments({ appUserId, tenantId: { $exists: false } })
    : 0;
  logger.info({ appUserId, tenantId, deleted: r.deletedCount, untagged }, 'agentIRCache: purged tenant IR');
  return { deleted: r.deletedCount ?? 0, untagged };
}
