import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { GeminiDestination } from '../../types.js';

/**
 * Tracks ADK/Reasoning-Engine deployments already made for a source agent, so
 * re-running a migration reuses the existing deployment instead of creating a
 * SECOND, billable Reasoning Engine every run.
 *
 * WHY THIS EXISTS: unlike the low-code `agents.create` REST call (which
 * rejects a duplicate by name — see gemini.ts createAgent's `alreadyExists`),
 * Vertex AI's Reasoning Engine `create` API has no such dedup — it always
 * mints a new, generated-id resource. Idempotency must be enforced here
 * instead. Best-effort like the rest of this project's persistence: the
 * pipeline must still run if Mongo is down (a re-run would just risk a
 * duplicate deploy in that case, not crash).
 *
 * Collection: adkDeployments (unique per {appUserId, envUrl, sourceId, project, engine}).
 */

const COLL = 'adkDeployments';

export interface AdkDeploymentRecord {
  reasoningEngine: string;
  agentId: string;
}

export async function recordAdkDeployment(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  dest: GeminiDestination,
  deployment: AdkDeploymentRecord,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { appUserId, envUrl, sourceId, project: dest.project, engine: dest.engine },
      {
        $set: {
          appUserId,
          envUrl,
          sourceId,
          project: dest.project,
          engine: dest.engine,
          reasoningEngine: deployment.reasoningEngine,
          agentId: deployment.agentId,
          deployedAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`recordAdkDeployment persist failed: ${(e as Error).message}`);
  }
}

export async function getAdkDeployment(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  dest: GeminiDestination,
): Promise<AdkDeploymentRecord | null> {
  if (!isDbConnected()) return null;
  try {
    const doc = await getDb(config.CSGE_DB)
      .collection(COLL)
      .findOne<AdkDeploymentRecord>({ appUserId, envUrl, sourceId, project: dest.project, engine: dest.engine });
    return doc ? { reasoningEngine: doc.reasoningEngine, agentId: doc.agentId } : null;
  } catch (e) {
    logger.warn(`getAdkDeployment read failed: ${(e as Error).message}`);
    return null;
  }
}
