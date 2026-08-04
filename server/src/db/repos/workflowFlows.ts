/**
 * workflowFlows repository — all DB reads/writes for workflow migration state.
 *
 * Collections:
 *   workflowFlows      — one doc per flow per customer+env
 *   workflowMigrations — one doc per customer+env (session-level summary)
 *   workflowAttempts   — append-only log of every migration attempt
 */

import { ObjectId, type Filter } from 'mongodb';
import { getDb } from '../core.js';
import type { FlowIR } from '../../types.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type FlowMigrationStatus =
  | 'pending'       // not yet attempted
  | 'migrating'     // currently processing
  | 'migrated'      // deployed + test passed
  | 'flagged'       // needs customer answers before migrating
  | 'failed'        // all retries exhausted
  | 'unsupported';  // cannot migrate — reason stored

export type MigrationSessionStatus =
  | 'scanning'
  | 'ready'
  | 'migrating'
  | 'done'
  | 'partial';

export interface WorkflowFlowDoc {
  _id?: ObjectId;
  appUserId: string;
  envUrl: string;
  sourceId: string;           // PA workflow GUID
  name: string;
  statecode: number;
  ir: FlowIR;                 // full extracted FlowIR
  status: FlowMigrationStatus;
  strategy: string;           // rule-based | hybrid | hermas | unsupported
  confidenceScore: number;
  customerAnswers: Record<string, string>;

  // Post-migration fields
  gcpWorkflowName: string | null;
  gcpYaml: string | null;
  gcpProjectId: string | null;
  gcpRegion: string | null;
  gcpWorkflowUrl: string | null;
  schedulerJobName: string | null;
  pubSubTopicName: string | null;

  // Test / parallel run
  testPassed: boolean | null;
  testOutput: unknown | null;
  testError: string | null;
  parallelResult: {
    match: boolean;
    paOutput: unknown;
    gcpOutput: unknown;
    comparedAt: Date;
  } | null;

  // Failure tracking
  attempts: number;
  lastError: string | null;
  unsupportedReason: string | null;
  warnings: string[];

  migratedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowMigrationDoc {
  _id?: ObjectId;
  appUserId: string;
  envUrl: string;
  status: MigrationSessionStatus;
  totalFlows: number;
  scannedAt: Date | null;
  startedAt: Date | null;
  completedAt: Date | null;
  summary: {
    pending: number;
    migrated: number;
    flagged: number;
    failed: number;
    unsupported: number;
  };
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkflowAttemptDoc {
  _id?: ObjectId;
  appUserId: string;
  flowSourceId: string;
  envUrl: string;
  attemptNumber: number;
  strategy: string;           // 'mapper' | 'hermas' | 'fix-loop'
  yamlGenerated: string | null;
  deployed: boolean;
  testPassed: boolean | null;
  error: string | null;
  attemptedAt: Date;
  durationMs: number;
}

// ── workflowFlows ─────────────────────────────────────────────────────────────

function col() {
  return getDb().collection<WorkflowFlowDoc>('workflowFlows');
}

/** Upsert a flow from scan — preserves existing status/answers if already in DB. */
export async function upsertFlow(
  appUserId: string,
  envUrl: string,
  ir: FlowIR,
): Promise<void> {
  const now = new Date();
  await col().updateOne(
    { appUserId, envUrl, sourceId: ir.sourceId },
    {
      $set: {
        appUserId,
        envUrl,
        sourceId: ir.sourceId,
        name: ir.name,
        statecode: ir.statecode,
        ir,
        strategy: ir.confidence.strategy,
        confidenceScore: ir.confidence.score,
        warnings: ir.confidence.unknownConnectors,
        updatedAt: now,
      },
      $setOnInsert: {
        status: ir.confidence.strategy === 'unsupported' ? 'unsupported' : 'pending',
        customerAnswers: {},
        gcpWorkflowName: null,
        gcpYaml: null,
        gcpProjectId: null,
        gcpRegion: null,
        gcpWorkflowUrl: null,
        schedulerJobName: null,
        pubSubTopicName: null,
        testPassed: null,
        testOutput: null,
        testError: null,
        parallelResult: null,
        attempts: 0,
        lastError: null,
        unsupportedReason: ir.confidence.strategy === 'unsupported'
          ? (ir.unmapped.length > 0 ? `Unmapped: ${ir.unmapped.join(', ')}` : 'Strategy unsupported')
          : null,
        migratedAt: null,
        createdAt: now,
      },
    },
    { upsert: true },
  );
}

/** Bulk upsert all flows from a scan. */
export async function upsertAllFlows(
  appUserId: string,
  envUrl: string,
  flows: FlowIR[],
): Promise<void> {
  await Promise.all(flows.map((ir) => upsertFlow(appUserId, envUrl, ir)));
}

/** Get flows for a customer+env, optionally filtered by status. */
export async function getFlows(
  appUserId: string,
  envUrl: string,
  status?: FlowMigrationStatus | FlowMigrationStatus[],
): Promise<WorkflowFlowDoc[]> {
  const filter: Filter<WorkflowFlowDoc> = { appUserId, envUrl };
  if (status) {
    filter.status = Array.isArray(status) ? { $in: status } : status;
  }
  return col().find(filter).sort({ name: 1 }).toArray();
}

/** Get single flow by sourceId. */
export async function getFlow(
  appUserId: string,
  envUrl: string,
  sourceId: string,
): Promise<WorkflowFlowDoc | null> {
  return col().findOne({ appUserId, envUrl, sourceId });
}

/** Mark flow as migrating (lock for processing). */
export async function setMigrating(
  appUserId: string,
  envUrl: string,
  sourceId: string,
): Promise<void> {
  await col().updateOne(
    { appUserId, envUrl, sourceId },
    { $set: { status: 'migrating', updatedAt: new Date() } },
  );
}

/** Save successful migration result. */
export async function setMigrated(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  update: {
    gcpWorkflowName: string;
    gcpYaml: string;
    gcpProjectId: string;
    gcpRegion: string;
    gcpWorkflowUrl: string;
    schedulerJobName?: string;
    pubSubTopicName?: string;
    testPassed: boolean;
    testOutput: unknown;
    testError: string | null;
  },
): Promise<void> {
  const now = new Date();
  await col().updateOne(
    { appUserId, envUrl, sourceId },
    {
      $set: {
        status: 'migrated',
        gcpWorkflowName: update.gcpWorkflowName,
        gcpYaml: update.gcpYaml,
        gcpProjectId: update.gcpProjectId,
        gcpRegion: update.gcpRegion,
        gcpWorkflowUrl: update.gcpWorkflowUrl,
        schedulerJobName: update.schedulerJobName ?? null,
        pubSubTopicName: update.pubSubTopicName ?? null,
        testPassed: update.testPassed,
        testOutput: update.testOutput,
        testError: update.testError,
        migratedAt: now,
        updatedAt: now,
      },
      $inc: { attempts: 1 },
    },
  );
}

/** Mark flow as failed after all retries. */
export async function setFailed(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  error: string,
): Promise<void> {
  await col().updateOne(
    { appUserId, envUrl, sourceId },
    {
      $set: { status: 'failed', lastError: error, updatedAt: new Date() },
      $inc: { attempts: 1 },
    },
  );
}

/** Mark flow as flagged (needs customer answers). */
export async function setFlagged(
  appUserId: string,
  envUrl: string,
  sourceId: string,
): Promise<void> {
  await col().updateOne(
    { appUserId, envUrl, sourceId },
    { $set: { status: 'flagged', updatedAt: new Date() } },
  );
}

/** Mark flow as unsupported with a reason. */
export async function setUnsupported(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  reason: string,
): Promise<void> {
  await col().updateOne(
    { appUserId, envUrl, sourceId },
    { $set: { status: 'unsupported', unsupportedReason: reason, updatedAt: new Date() } },
  );
}

/** Save customer answers for gap questions. */
export async function saveAnswers(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  answers: Record<string, string>,
): Promise<void> {
  await col().updateOne(
    { appUserId, envUrl, sourceId },
    {
      $set: {
        customerAnswers: answers,
        status: 'pending',   // reset to pending so it gets retried
        updatedAt: new Date(),
      },
    },
  );
}

/** Save parallel run comparison result. */
export async function setParallelResult(
  appUserId: string,
  envUrl: string,
  sourceId: string,
  result: { match: boolean; paOutput: unknown; gcpOutput: unknown },
): Promise<void> {
  await col().updateOne(
    { appUserId, envUrl, sourceId },
    {
      $set: {
        parallelResult: { ...result, comparedAt: new Date() },
        updatedAt: new Date(),
      },
    },
  );
}

/** Count flows by status for summary. */
export async function countByStatus(
  appUserId: string,
  envUrl: string,
): Promise<Record<FlowMigrationStatus, number>> {
  const pipeline = [
    { $match: { appUserId, envUrl } },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ];
  const rows = await col().aggregate<{ _id: string; count: number }>(pipeline).toArray();
  const result: Record<string, number> = {
    pending: 0, migrating: 0, migrated: 0, flagged: 0, failed: 0, unsupported: 0,
  };
  for (const r of rows) result[r._id] = r.count;
  return result as Record<FlowMigrationStatus, number>;
}

// ── workflowMigrations (session) ──────────────────────────────────────────────

function sessionCol() {
  return getDb().collection<WorkflowMigrationDoc>('workflowMigrations');
}

export async function getOrCreateSession(
  appUserId: string,
  envUrl: string,
): Promise<WorkflowMigrationDoc> {
  const now = new Date();
  const existing = await sessionCol().findOne({ appUserId, envUrl });
  if (existing) return existing;

  const doc: WorkflowMigrationDoc = {
    appUserId,
    envUrl,
    status: 'scanning',
    totalFlows: 0,
    scannedAt: null,
    startedAt: null,
    completedAt: null,
    summary: { pending: 0, migrated: 0, flagged: 0, failed: 0, unsupported: 0 },
    createdAt: now,
    updatedAt: now,
  };
  await sessionCol().insertOne(doc);
  return doc;
}

export async function updateSession(
  appUserId: string,
  envUrl: string,
  update: Partial<WorkflowMigrationDoc>,
): Promise<void> {
  await sessionCol().updateOne(
    { appUserId, envUrl },
    { $set: { ...update, updatedAt: new Date() } },
    { upsert: true },
  );
}

export async function refreshSessionSummary(
  appUserId: string,
  envUrl: string,
): Promise<void> {
  const counts = await countByStatus(appUserId, envUrl);
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  const allDone = counts.pending === 0 && counts.migrating === 0;
  await updateSession(appUserId, envUrl, {
    totalFlows: total,
    summary: {
      pending: counts.pending,
      migrated: counts.migrated,
      flagged: counts.flagged,
      failed: counts.failed,
      unsupported: counts.unsupported,
    },
    status: allDone
      ? (counts.failed > 0 || counts.flagged > 0 ? 'partial' : 'done')
      : 'migrating',
  });
}

// ── workflowAttempts ──────────────────────────────────────────────────────────

function attemptCol() {
  return getDb().collection<WorkflowAttemptDoc>('workflowAttempts');
}

export async function logAttempt(attempt: Omit<WorkflowAttemptDoc, '_id'>): Promise<void> {
  await attemptCol().insertOne(attempt);
}

export async function getAttempts(
  appUserId: string,
  envUrl: string,
  flowSourceId: string,
): Promise<WorkflowAttemptDoc[]> {
  return attemptCol()
    .find({ appUserId, envUrl, flowSourceId })
    .sort({ attemptedAt: -1 })
    .toArray();
}
