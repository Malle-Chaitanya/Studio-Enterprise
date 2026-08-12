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

/** One deployed ADK agent, with enough context for a UI to label and invoke it. */
export interface AdkDeploymentListing extends AdkDeploymentRecord {
  sourceId: string;
  envUrl: string;
  project: string;
  engine: string;
  deployedAt?: Date;
}

/**
 * Every ADK agent deployed by this tenant, newest first — powers the "chat with
 * a migrated agent" screen. Scoped by appUserId like every other
 * migration-scoped read; never take the tenant from the client.
 */
export async function listAdkDeployments(appUserId: string, limit = 100): Promise<AdkDeploymentListing[]> {
  if (!isDbConnected()) return [];
  try {
    return await getDb(config.CSGE_DB)
      .collection(COLL)
      .find<AdkDeploymentListing>({ appUserId })
      .sort({ deployedAt: -1 })
      .limit(limit)
      .toArray();
  } catch (e) {
    logger.warn(`listAdkDeployments read failed: ${(e as Error).message}`);
    return [];
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
    if (doc) return { reasoningEngine: doc.reasoningEngine, agentId: doc.agentId };

    // The SAME Google project can reach us under two names — the project ID
    // (`studio-enterprise-migration`) and the project NUMBER (`231705905417`) — depending on
    // which path resolved the destination. With `project` in the match, one run failed to
    // find the other's record and deployed a SECOND agent under the same display name.
    // Observed live: Confluence_agent recorded twice on 2026-08-07, four hours apart, one
    // row per spelling, and the customer saw two identical agents in the gallery with no
    // way to tell which was current.
    //
    // The engine id is already unique to one project, so matching without `project` is safe
    // and repairs the split. Kept as a FALLBACK, not the primary match, so an exact record
    // still wins.
    const byEngine = await getDb(config.CSGE_DB)
      .collection(COLL)
      .find<AdkDeploymentRecord & { deployedAt?: Date }>({ appUserId, envUrl, sourceId, engine: dest.engine })
      .sort({ deployedAt: -1 })
      .limit(1)
      .next();
    if (byEngine) {
      logger.info(
        { sourceId, engine: dest.engine },
        'adkDeployments: matched an existing deployment by engine — the project was recorded under a different spelling',
      );
      return { reasoningEngine: byEngine.reasoningEngine, agentId: byEngine.agentId };
    }
    return null;
  } catch (e) {
    logger.warn(`getAdkDeployment read failed: ${(e as Error).message}`);
    return null;
  }
}
