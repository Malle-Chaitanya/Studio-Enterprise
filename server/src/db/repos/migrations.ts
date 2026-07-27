import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type {
  DestinationOptions,
  MigrationResult,
  MigrationScope,
  ResolvedPlan,
} from '../../types.js';

/**
 * Persistence for a migration run and its per-agent results + logs.
 * Collections: migrationRuns, migrationResults, migrationLogs.
 *
 * Every write is best-effort: if Mongo is down the migration still runs, we just
 * log a warning (parity with GEM_CO's "run without persistence" fallback).
 */

const RUNS = 'migrationRuns';
const RESULTS = 'migrationResults';
const LOGS = 'migrationLogs';

export interface RunInit {
  runId: string;
  appUserId: string;
  sessionId?: string;
  orgName?: string;
  scope: MigrationScope;
  plan: ResolvedPlan;
  destination: DestinationOptions;
}

/** Insert a migrationRuns doc at the start of a run. */
export async function startRun(init: RunInit): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(RUNS).insertOne({
      _id: init.runId,
      appUserId: init.appUserId,
      sessionId: init.sessionId,
      orgName: init.orgName,
      scope: init.scope,
      plan: init.plan,
      destination: init.destination,
      totalAgents: init.plan.totalAgents,
      status: 'running',
      startTime: new Date(),
    } as never);
  } catch (e) {
    logger.warn(`startRun persist failed: ${(e as Error).message}`);
  }
}

/** Update a run with its final status + summary. */
export async function finishRun(runId: string, summary: string, status = 'done'): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(RUNS).updateOne(
      { _id: runId as never },
      { $set: { status, summary, endTime: new Date() } },
    );
  } catch (e) {
    logger.warn(`finishRun persist failed: ${(e as Error).message}`);
  }
}

/** Upsert one agent's MigrationResult (unique per {runId, sourceId}). */
export async function saveResult(
  runId: string,
  appUserId: string,
  result: MigrationResult,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(RESULTS).updateOne(
      { runId, sourceId: result.sourceId },
      { $set: { runId, appUserId, ...result, updatedAt: new Date() } },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`saveResult persist failed: ${(e as Error).message}`);
  }
}

/** Append one progress log line for a run. */
export async function appendLog(
  runId: string,
  appUserId: string,
  level: string,
  msg: string,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(LOGS).insertOne({
      runId,
      appUserId,
      level,
      msg,
      ts: new Date(),
    } as never);
  } catch (e) {
    // Logs are the least critical write — swallow quietly to avoid log spam.
    logger.debug(`appendLog persist failed: ${(e as Error).message}`);
  }
}
