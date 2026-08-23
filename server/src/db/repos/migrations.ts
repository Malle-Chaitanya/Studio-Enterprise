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

/**
 * Mark runs that were in flight when the process died.
 *
 * A migration only ever leaves `running` because `finishRun` says so, and that call is
 * in-process. So a crash, a deploy, or a `tsx watch` restart mid-run strands the row at
 * `running` forever — measured 2026-08-12: five such rows, one of them from a restart
 * caused by editing a server file while a migration was deploying. Nothing reconciled
 * them, so "is this migration still going?" had no truthful answer.
 *
 * Called once on boot. Any run still `running` at that moment cannot be ours — this
 * process has just started and owns no runs — so it is safe to close them all.
 * `interrupted` rather than `failed`: we do not know how far it got, and the staged rows
 * are still there for a resume.
 */
export async function reconcileInterruptedRuns(): Promise<number> {
  if (!isDbConnected()) return 0;
  try {
    const res = await getDb(config.CSGE_DB).collection(RUNS).updateMany(
      { status: 'running' },
      {
        $set: {
          status: 'interrupted',
          summary: 'Interrupted — the server restarted while this migration was running. Staged agents were kept; re-run to continue from the insert.',
          endTime: new Date(),
        },
      },
    );
    return res.modifiedCount;
  } catch (e) {
    logger.warn(`reconcileInterruptedRuns failed: ${(e as Error).message}`);
    return 0;
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

/** One past run, with just enough to render a history row. */
export interface RunSummary {
  runId: string;
  startedAt?: Date;
  finishedAt?: Date;
  status?: string;
  summary?: string;
  agentCount: number;
  verifiedCount: number;
  failedCount: number;
}

/**
 * Past runs for one tenant, newest first.
 *
 * ALWAYS scoped by appUserId — migrationRuns is a migration-scoped collection, and a query
 * without that filter is a cross-tenant leak, not merely a broad read.
 *
 * Counts are computed from the results rather than stored on the run, because a run that
 * crashed mid-flight never got to write a total and would otherwise report zero agents when
 * it actually migrated several. `verifiedCount` counts only `verifyStatus === 'verified'`:
 * an unknown is a check nobody has done, and folding it into the verified total is the
 * overclaiming this project's rules forbid.
 */
export async function listRuns(
  appUserId: string,
  { limit = 20 }: { limit?: number } = {},
): Promise<RunSummary[]> {
  if (!isDbConnected()) return [];
  try {
    const db = getDb(config.CSGE_DB);
    const runs = await db
      .collection(RUNS)
      .find({ appUserId })
      // startTime, not startedAt: createRun writes `startTime` (line ~47) and
      // completeRun writes `endTime`. Reading `startedAt` here sorted on a field
      // that does not exist, so Past runs came back in arbitrary order and every
      // row rendered "Invalid Date" in the UI.
      .sort({ startTime: -1, _id: -1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .toArray();
    const out: RunSummary[] = [];
    for (const r of runs) {
      const runId = String(r.runId ?? r._id);
      const results = await db
        .collection(RESULTS)
        .find({ appUserId, runId }, { projection: { verifyStatus: 1, created: 1 } })
        .toArray();
      out.push({
        runId,
        startedAt: r.startTime ?? r.startedAt,
        finishedAt: r.endTime ?? r.finishedAt,
        status: r.status,
        summary: r.summary,
        agentCount: results.length,
        verifiedCount: results.filter((x) => x.verifyStatus === 'verified').length,
        failedCount: results.filter((x) => x.created === false || x.verifyStatus === 'failed').length,
      });
    }
    return out;
  } catch (e) {
    logger.warn(`listRuns failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * The run's own header row: who it ran between, when, and how long it took.
 *
 * Tenant-scoped like everything else here -- the appUserId is part of the filter, not a
 * check afterwards, so another customer's run simply is not found.
 *
 * Separate from getRunResults because the report needs both and they are different
 * collections; returning null rather than throwing keeps an unknown run and a Mongo
 * outage on the same best-effort path as the rest of this module.
 */
export async function getRunHeader(
  appUserId: string,
  runId: string,
): Promise<{
  runId: string;
  orgName?: string;
  destination?: unknown;
  status?: string;
  startedAt?: Date;
  finishedAt?: Date;
} | null> {
  if (!isDbConnected()) return null;
  try {
    const r = await getDb(config.CSGE_DB)
      .collection(RUNS)
      .findOne({ appUserId, $or: [{ runId }, { _id: runId }] } as never);
    if (!r) return null;
    return {
      runId,
      orgName: r.orgName,
      destination: r.destination,
      status: r.status,
      // Same field-name trap as listRuns: the writer uses startTime/endTime.
      startedAt: r.startTime ?? r.startedAt,
      finishedAt: r.endTime ?? r.finishedAt,
    };
  } catch (e) {
    logger.warn(`getRunHeader failed: ${(e as Error).message}`);
    return null;
  }
}

/** Every agent result for one run, tenant-scoped. */
export async function getRunResults(
  appUserId: string,
  runId: string,
): Promise<MigrationResult[]> {
  if (!isDbConnected()) return [];
  try {
    const rows = await getDb(config.CSGE_DB)
      .collection(RESULTS)
      .find({ appUserId, runId })
      .toArray();
    return rows as unknown as MigrationResult[];
  } catch (e) {
    logger.warn(`getRunResults failed: ${(e as Error).message}`);
    return [];
  }
}
