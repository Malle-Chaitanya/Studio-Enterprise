import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * Tracks Application Integration resources already created for a source Agent Flow, so
 * re-running a migration versions the SAME integration instead of creating a duplicate.
 *
 * WHY THIS EXISTS: mirrors db/repos/adkDeployments.ts's reasoning exactly, one layer down —
 * `versions:upload` always accepts a new version under whatever integration NAME you give
 * it, so idempotency has to be enforced by always reusing the same deterministic name for
 * a given source flow, tracked here. Best-effort like every other repo: the pipeline must
 * still run if Mongo is down.
 *
 * Collection: flowIntegrations (unique per {appUserId, envUrl, sourceId, project, location}).
 */

const COLL = 'flowIntegrations';

export interface FlowIntegrationRecord {
  integrationName: string;
  latestVersionId?: string;
  definitionHash: string;
}

/** Stable hash of a translated integration definition, used to skip a re-upload when
 *  nothing about the flow's translation actually changed since the last run. */
export function hashDefinition(def: unknown): string {
  return createHash('sha256').update(JSON.stringify(def)).digest('hex');
}

export async function getFlowIntegration(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  project: string,
  location: string,
): Promise<FlowIntegrationRecord | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb(config.CSGE_DB)
      .collection(COLL)
      .findOne<FlowIntegrationRecord>({ appUserId, envUrl, sourceId, project, location });
  } catch (e) {
    logger.warn(`getFlowIntegration read failed: ${(e as Error).message}`);
    return null;
  }
}

export async function recordFlowIntegration(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  project: string,
  location: string,
  record: FlowIntegrationRecord,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { appUserId, envUrl, sourceId, project, location },
      {
        $set: {
          appUserId,
          envUrl,
          sourceId,
          project,
          location,
          integrationName: record.integrationName,
          latestVersionId: record.latestVersionId,
          definitionHash: record.definitionHash,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`recordFlowIntegration persist failed: ${(e as Error).message}`);
  }
}
