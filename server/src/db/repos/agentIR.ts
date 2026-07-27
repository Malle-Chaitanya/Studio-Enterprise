import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { AgentIR, MappedAgent } from '../../types.js';

/**
 * Cache of extracted AgentIR + MappedAgent per source agent.
 * Collection: agentIRCache (unique {appUserId, envUrl, sourceId}).
 *
 * Purpose: audit trail + skip re-extraction from Dataverse on re-runs. The IR is
 * the expensive-to-produce, platform-neutral heart of the pipeline (see
 * types.ts), so it's worth persisting.
 */

const COLL = 'agentIRCache';

export async function cacheAgentIR(
  appUserId: string,
  envUrl: string,
  ir: AgentIR,
  mapped: MappedAgent,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { appUserId, envUrl, sourceId: ir.sourceId },
      { $set: { appUserId, envUrl, sourceId: ir.sourceId, ir, mapped, extractedAt: new Date() } },
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
