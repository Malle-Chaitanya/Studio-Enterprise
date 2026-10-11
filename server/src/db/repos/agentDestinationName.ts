import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * The customer-chosen display name for one source agent's Gemini counterpart.
 *
 * WHY THIS EXISTS: `mapAgent` used to hardcode `displayName: ir.name`, so the
 * destination always mirrored the source name with no way to rename it before a
 * run. Absence of a record here means "use the source name" — this is an
 * override, not a required field, so an agent nobody renamed behaves exactly as
 * before.
 *
 * Read ONCE per run and reused on every later run of the SAME agent, never
 * re-derived from the source: the low-code `agents.create` path dedupes by
 * display name on Gemini's own side, so a name that changed between two runs
 * of the same agent would read as a brand-new agent rather than the same one —
 * see docs/connector-architecture-decisions.md-style reasoning in
 * orchestrator.ts's ADK idempotency comment. Keeping the stored name stable
 * across runs is what keeps that dedup working, exactly as it did when the
 * name was always the source name.
 */
export interface AgentDestinationName {
  appUserId: string;
  sourceId: string;
  destinationName: string;
  createdAt: Date;
  updatedAt: Date;
}

const COLL = 'agentDestinationNames';

export async function getAgentDestinationName(
  appUserId: string,
  sourceId: string,
): Promise<string | null> {
  if (!isDbConnected()) return null;
  try {
    const doc = await getDb(config.CSGE_DB).collection<AgentDestinationName>(COLL).findOne({ appUserId, sourceId });
    return doc?.destinationName ?? null;
  } catch (e) {
    logger.warn(`getAgentDestinationName read failed: ${(e as Error).message}`);
    return null;
  }
}

/** Batch read for a screen listing many agents at once — one round trip, not N. */
export async function getAgentDestinationNames(
  appUserId: string,
  sourceIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!isDbConnected() || sourceIds.length === 0) return out;
  try {
    const docs = await getDb(config.CSGE_DB).collection<AgentDestinationName>(COLL)
      .find({ appUserId, sourceId: { $in: sourceIds } }).toArray();
    for (const d of docs) out.set(d.sourceId, d.destinationName);
    return out;
  } catch (e) {
    logger.warn(`getAgentDestinationNames read failed: ${(e as Error).message}`);
    return out;
  }
}

export async function setAgentDestinationName(
  appUserId: string,
  sourceId: string,
  destinationName: string,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    const now = new Date();
    await getDb(config.CSGE_DB).collection<AgentDestinationName>(COLL).updateOne(
      { appUserId, sourceId },
      { $set: { destinationName, appUserId, sourceId, updatedAt: now }, $setOnInsert: { createdAt: now } },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`setAgentDestinationName persist failed: ${(e as Error).message}`);
  }
}

/** Back to the source name — deletes the override rather than storing an empty string. */
export async function clearAgentDestinationName(appUserId: string, sourceId: string): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection<AgentDestinationName>(COLL).deleteOne({ appUserId, sourceId });
  } catch (e) {
    logger.warn(`clearAgentDestinationName delete failed: ${(e as Error).message}`);
  }
}
