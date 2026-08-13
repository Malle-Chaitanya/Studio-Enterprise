import type { GeminiDestination, KnowledgeSourceIR } from '../types.js';
import { config } from '../config.js';
import { resolvePrimaryKey, resolveTableSearchTarget, exportTableRows, type DataverseRow, type TableSearchTarget } from './dataverseTableExport.js';
import { resolveTableAttributes, buildBqSchema, exportTableRowsForBigQuery } from './dataverseTableSchema.js';
import { ensureBigQueryApiEnabled, ensureBqDataset, ensureBqTable, loadRowsToBqTable, awaitBqJob } from './bigqueryUpload.js';
import {
  createDataStore,
  importStructuredInline,
  importStructuredFromBigQuery,
  importDocumentsFromGcs,
  awaitImport,
  dataStoreResourcePath,
} from './geminiDataStore.js';
import { sanitizeDataStoreId } from './knowledgePlanner.js';
import { downloadDriveItemBytes, type DriveItemRef } from './graphFiles.js';
import { ensureBucket, uploadBytesToGcs } from './gcsUpload.js';
import {
  uploadAgentFile,
  updateAgentFiles,
  getAgent,
  readAgentFiles,
  mimeTypeForFile,
  type AgentFile,
} from './geminiAgentFiles.js';

/**
 * Executes the `dataverse-snapshot` knowledge strategy: read a reference
 * table's rows from Dataverse, snapshot them into a Gemini structured data
 * store. This is what lets a migrated agent actually answer from that table —
 * without it, the agent lists the source but can't retrieve from it (a lossy
 * migration, not a real one).
 *
 * Idempotent end to end: row ids are the table's real Dataverse primary key
 * (never guessed), and Discovery Engine's INCREMENTAL reconciliation upserts
 * by id — re-running the migration refreshes the snapshot in place instead of
 * duplicating rows. The data store id is likewise derived from the agent id +
 * table name, so re-creation is a no-op (`createDataStore` already treats 409
 * as `alreadyExists`, not an error).
 *
 * Only call this for sources already classified `dataverse-snapshot` — the
 * classifier has already screened out sensitive/transactional tables, which
 * must be rebuilt as a live tool instead (see knowledgeClassifier.ts).
 */

const CHUNK_SIZE = 100; // Discovery Engine's inline-import cap per request
const BQ_DATASET_ID = 'csge_reference_snapshots'; // one dataset per Gemini project, not per agent

export interface DataverseSnapshotResult {
  attempted: number;
  succeeded: number;
  failed: number;
  dataStoreId?: string;
  /** Full Discovery Engine resource path — set ONLY once the data store is
   *  actually built and importable, i.e. usable by either destination path
   *  (low-code's attachDataStoreToEngine, or ADK's VertexAiSearchTool
   *  groundingDataStores — see orchestrator.ts). Absent on any failure branch. */
  resourcePath?: string;
  error?: string;
  failureSamples?: string[];
  /** True when this run took the BigQuery-mediated path (large table) instead of inline. */
  viaBigQuery?: boolean;
  bqDatasetId?: string;
  bqTableId?: string;
  /** Per-column fidelity notes (lookups/choices/money flattened, etc). Only set when viaBigQuery. */
  schemaNotes?: string[];
}

/** BigQuery dataset/table identifiers: letters/digits/underscores only, must not start with a digit. */
function sanitizeBqIdentifier(raw: string): string {
  const base = (raw || 'tbl').replace(/[^a-zA-Z0-9_]/g, '_');
  const safe = /^[0-9]/.test(base) ? `_${base}` : base;
  return (safe || 'tbl').slice(0, 300);
}

/**
 * Executes the `dataverse-snapshot` knowledge strategy: read a reference
 * table's rows from Dataverse, snapshot them into a Gemini structured data
 * store. This is what lets a migrated agent actually answer from that table —
 * without it, the agent lists the source but can't retrieve from it (a lossy
 * migration, not a real one).
 *
 * Routes between two executors by row count (config.BQ_SNAPSHOT_ROW_THRESHOLD,
 * default 200): small tables go through Discovery Engine's inline
 * documents:import (no extra per-customer GCP footprint — no dataset, no
 * BigQuery API enablement, no extra IAM role); large tables go through a
 * BigQuery staging table first (no 100-row/request cap, and real typed
 * columns instead of raw JSON). Inline is kept as the default rather than
 * removed — see .claude/memory/decisions.md (2026-08-04) for why.
 *
 * Idempotent end to end in both paths: row ids are the table's real Dataverse
 * primary key (never guessed), and re-running refreshes the snapshot in place
 * instead of duplicating rows — inline via Discovery Engine's INCREMENTAL
 * upsert-by-id, BigQuery via WRITE_TRUNCATE (load) + FULL reconciliation
 * (import). The data store id is likewise derived from the agent id + table
 * name, so re-creation is a no-op (`createDataStore` already treats 409 as
 * `alreadyExists`, not an error).
 *
 * Only call this for sources already classified `dataverse-snapshot` — the
 * classifier has already screened out sensitive/transactional tables, which
 * must be rebuilt as a live tool instead (see knowledgeClassifier.ts).
 */
export async function migrateDataverseSnapshot(
  dest: GeminiDestination,
  saToken: string,
  dvToken: string,
  envUrl: string,
  agentSourceId: string,
  source: KnowledgeSourceIR,
  /** Explicit table to snapshot. Set by the caller when one source names several
   *  tables (each gets its own call); omitted, the first resolved table is used. */
  targetOverride?: TableSearchTarget,
): Promise<DataverseSnapshotResult> {
  const capturedRef = (source.references?.[0] ?? source.reference ?? '').trim();
  if (!capturedRef) {
    return { attempted: 0, succeeded: 0, failed: 0, error: 'no table reference captured for this source' };
  }

  let entitySetName: string;
  let pk: string;
  if (targetOverride) {
    entitySetName = targetOverride.entitySetName;
    pk = targetOverride.primaryKeyAttr;
  } else {
    // The captured reference is a "Dataverse table search" config record's NAME,
    // not the target table's EntitySetName — resolve the real linkage first
    // (dvtablesearch -> dvtablesearchentity -> EntityDefinitions). See
    // resolveTableSearchTarget's doc comment for why this indirection exists.
    const { targets, unconfigured } = await resolveTableSearchTarget(envUrl, dvToken, capturedRef);
    if (targets.length) {
      entitySetName = targets[0].entitySetName;
      pk = targets[0].primaryKeyAttr;
    } else if (unconfigured) {
      return {
        attempted: 0,
        succeeded: 0,
        failed: 0,
        error: `Dataverse table-search source has no table selected in Copilot Studio — nothing to migrate (this is a gap in the source agent's configuration, not an extraction failure)`,
      };
    } else {
      // Fall back to treating the captured reference as a literal EntitySetName,
      // in case some other source shape ever reaches this path directly.
      entitySetName = capturedRef;
      const fallbackPk = await resolvePrimaryKey(envUrl, dvToken, entitySetName);
      if (!fallbackPk) {
        return {
          attempted: 0,
          succeeded: 0,
          failed: 0,
          error: `could not resolve "${entitySetName}" as a Dataverse table or table-search config (EntityDefinitions lookup failed)`,
        };
      }
      pk = fallbackPk;
    }
  }

  const threshold = config.BQ_SNAPSHOT_ROW_THRESHOLD;
  // Single probing fetch doubles as the actual inline payload when the table
  // is small — no wasted re-fetch for the common (small-table) case. If it
  // comes back at exactly threshold+1, the table is large; that partial,
  // untyped fetch is discarded in favor of the properly-typed BigQuery export.
  const probeRows = await exportTableRows(envUrl, dvToken, entitySetName, pk, threshold + 1);
  if (!probeRows.length) {
    return { attempted: 0, succeeded: 0, failed: 0, error: `table "${entitySetName}" returned no rows` };
  }

  const dataStoreId = sanitizeDataStoreId(`${agentSourceId}-tbl-${entitySetName}`);

  if (probeRows.length <= threshold) {
    return runInlineSnapshot(dest, saToken, dataStoreId, entitySetName, agentSourceId, probeRows);
  }
  return runBigQuerySnapshot(dest, saToken, envUrl, dvToken, entitySetName, pk, agentSourceId, dataStoreId);
}

/** Small-table path — Discovery Engine inline documents:import, chunked. Behavior unchanged from before the BigQuery split. */
async function runInlineSnapshot(
  dest: GeminiDestination,
  saToken: string,
  dataStoreId: string,
  entitySetName: string,
  agentSourceId: string,
  rows: DataverseRow[],
): Promise<DataverseSnapshotResult> {
  const created = await createDataStore(dest.project, saToken, {
    dataStoreId,
    displayName: `${entitySetName} (Dataverse snapshot — ${agentSourceId})`,
    kind: 'structured',
  });
  if (!created.created && !created.alreadyExists) {
    return { attempted: rows.length, succeeded: 0, failed: rows.length, dataStoreId, error: created.error };
  }

  let succeeded = 0;
  let failed = 0;
  const failureSamples: string[] = [];
  for (let i = 0; i < rows.length; i += CHUNK_SIZE) {
    const chunk = rows.slice(i, i + CHUNK_SIZE);
    const started = await importStructuredInline(
      dest.project,
      saToken,
      dataStoreId,
      chunk.map((r) => ({ id: r.id, structData: r.data })),
    );
    if (!started.started || !started.operationName) {
      failed += chunk.length;
      if (started.error) failureSamples.push(started.error);
      continue;
    }
    const reconciled = await awaitImport(saToken, started.operationName, chunk.length);
    succeeded += reconciled.succeeded;
    failed += reconciled.failed;
    failureSamples.push(...reconciled.failureSamples);
  }

  // Attaching this store to a destination is the CALLER's job now
  // (orchestrator.ts) — low-code attaches it engine-wide via
  // attachDataStoreToEngine; ADK bakes resourcePath into VertexAiSearchTool
  // at deploy time instead. Resolution here is path-agnostic on purpose.
  return {
    attempted: rows.length,
    succeeded,
    failed,
    dataStoreId,
    resourcePath: dataStoreResourcePath(dest.project, dataStoreId),
    failureSamples: failureSamples.slice(0, 5),
  };
}

/**
 * Large-table path — stage rows in a per-project BigQuery table (real typed
 * columns via dataverseTableSchema.ts, no 100-row/request cap), then a single
 * documents:import from BigQuery. Never blocks the migration: if the
 * BigQuery API can't be enabled or the dataset/table can't be created (e.g.
 * the customer's SA grant doesn't include bigquery.dataEditor/jobUser), this
 * returns a `needs-review`-worthy error instead of throwing — orchestrator.ts
 * surfaces it as a FidelityNote, same posture as adkDeployer's
 * ensureReasoningEngineDiscoveryAccess.
 */
async function runBigQuerySnapshot(
  dest: GeminiDestination,
  saToken: string,
  envUrl: string,
  dvToken: string,
  entitySetName: string,
  pk: string,
  agentSourceId: string,
  dataStoreId: string,
): Promise<DataverseSnapshotResult> {
  const apiReady = await ensureBigQueryApiEnabled(saToken, dest.project);
  if (!apiReady.ok) {
    return { attempted: 0, succeeded: 0, failed: 0, dataStoreId, viaBigQuery: true, error: `BigQuery API: ${apiReady.error}` };
  }
  const datasetReady = await ensureBqDataset(saToken, dest.project, BQ_DATASET_ID, config.BQ_SNAPSHOT_DATASET_LOCATION);
  if (!datasetReady.ok) {
    return { attempted: 0, succeeded: 0, failed: 0, dataStoreId, viaBigQuery: true, error: `BigQuery dataset: ${datasetReady.error}` };
  }

  const attrs = await resolveTableAttributes(envUrl, dvToken, entitySetName);
  if (!attrs) {
    return {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      dataStoreId,
      viaBigQuery: true,
      error: `could not resolve "${entitySetName}" attribute metadata for BigQuery schema`,
    };
  }
  const { schema, plan, flattenedNotes } = buildBqSchema(attrs, pk);
  const tableId = sanitizeBqIdentifier(`${agentSourceId}_tbl_${entitySetName}`);

  const tableReady = await ensureBqTable(saToken, dest.project, BQ_DATASET_ID, tableId, schema);
  if (!tableReady.ok) {
    return { attempted: 0, succeeded: 0, failed: 0, dataStoreId, viaBigQuery: true, error: `BigQuery table: ${tableReady.error}` };
  }

  const rows = await exportTableRowsForBigQuery(envUrl, dvToken, entitySetName, pk, plan, Number.MAX_SAFE_INTEGER);
  if (!rows.length) {
    return {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      dataStoreId,
      viaBigQuery: true,
      error: `table "${entitySetName}" returned no rows (BigQuery path)`,
    };
  }

  const load = await loadRowsToBqTable(saToken, dest.project, BQ_DATASET_ID, tableId, rows);
  if (!load.started || !load.jobId) {
    return {
      attempted: rows.length,
      succeeded: 0,
      failed: rows.length,
      dataStoreId,
      viaBigQuery: true,
      bqDatasetId: BQ_DATASET_ID,
      bqTableId: tableId,
      error: `BigQuery load job: ${load.error}`,
    };
  }
  const jobDone = await awaitBqJob(saToken, dest.project, load.jobId);
  if (!jobDone.ok) {
    return {
      attempted: rows.length,
      succeeded: 0,
      failed: rows.length,
      dataStoreId,
      viaBigQuery: true,
      bqDatasetId: BQ_DATASET_ID,
      bqTableId: tableId,
      error: `BigQuery load job: ${jobDone.error}`,
    };
  }

  const created = await createDataStore(dest.project, saToken, {
    dataStoreId,
    displayName: `${entitySetName} (Dataverse snapshot — ${agentSourceId})`,
    kind: 'structured',
  });
  if (!created.created && !created.alreadyExists) {
    return {
      attempted: rows.length,
      succeeded: 0,
      failed: rows.length,
      dataStoreId,
      viaBigQuery: true,
      bqDatasetId: BQ_DATASET_ID,
      bqTableId: tableId,
      error: created.error,
    };
  }

  const started = await importStructuredFromBigQuery(dest.project, saToken, dataStoreId, {
    datasetId: BQ_DATASET_ID,
    tableId,
    idField: 'id',
  });
  if (!started.started || !started.operationName) {
    return {
      attempted: rows.length,
      succeeded: 0,
      failed: rows.length,
      dataStoreId,
      viaBigQuery: true,
      bqDatasetId: BQ_DATASET_ID,
      bqTableId: tableId,
      error: started.error,
    };
  }
  // Larger poll budget than the inline path's default (5 min): live-tested against
  // a real 259-row, ~400-column table and the import operation itself took ~11
  // minutes to actually finish. awaitImport's 5-min default (tuned for inline's
  // ≤100-doc chunks) gave up early and reconciled against a still-in-progress
  // snapshot, misreporting a real success as a total failure — confirmed via the
  // operation's own metadata (successCount/totalCount both matched rows.length)
  // once it actually completed. 30 min covers meaningfully larger tables too.
  const reconciled = await awaitImport(saToken, started.operationName, rows.length, { maxPolls: 360, intervalMs: 5000 });

  // Attaching is the caller's job now — see the comment in runInlineSnapshot's return.
  return {
    attempted: rows.length,
    succeeded: reconciled.succeeded,
    failed: reconciled.failed,
    dataStoreId,
    resourcePath: dataStoreResourcePath(dest.project, dataStoreId),
    failureSamples: reconciled.failureSamples.slice(0, 5),
    viaBigQuery: true,
    bqDatasetId: BQ_DATASET_ID,
    bqTableId: tableId,
    schemaNotes: flattenedNotes,
  };
}

export interface FileGroundingResult {
  attempted: number;
  succeeded: number;
  failed: number;
  dataStoreId?: string;
  /** Full Discovery Engine resource path — feed this into adkDeployer.ts's
   *  AdkSpec.groundingDataStores so VertexAiSearchTool can query it. */
  resourcePath?: string;
  error?: string;
}

/**
 * Grounds a locally-uploaded knowledge file on an ADK agent: stages the bytes
 * in GCS, creates (idempotently) a Discovery Engine "document" data store,
 * imports the file into it, and returns its resource path.
 *
 * This is the ADK-path equivalent of orchestrator.ts's attachKnowledgeFiles()
 * (which uses agentFiles) — ADK agents don't have an agentFiles concept at
 * all (see adkDeployer.ts / decisions.md), so a searchable data store +
 * VertexAiSearchTool is the only way for an ADK agent to answer from an
 * uploaded file's content.
 *
 * ⚠️ Live-verified 2026-08-03 that this mechanism works end to end (upload →
 * data store → import → VertexAiSearchTool retrieval), but ONLY once the
 * Reasoning Engine's runtime service agent has Discovery Engine read access
 * on the project — see adkDeployer.ts's ensureReasoningEngineDiscoveryAccess.
 * Without that grant, the deployed agent 403s at query time even though
 * every step here succeeds.
 *
 * Idempotent: the data store id is derived from the agent + file name, so a
 * re-run reuses the same store (createDataStore already treats 409 as
 * alreadyExists) and re-imports the same GCS object (INCREMENTAL
 * reconciliation upserts by document id — no duplicates).
 */
export async function migrateFileToDocumentStore(
  project: string,
  saToken: string,
  agentSourceId: string,
  file: { name: string; bytes: Buffer; mimeType: string },
): Promise<FileGroundingResult> {
  let dataStoreId = sanitizeDataStoreId(`${agentSourceId}-file-${file.name}`);
  let created = await createDataStore(project, saToken, {
    dataStoreId,
    displayName: `${file.name} (ADK file grounding — ${agentSourceId})`,
    kind: 'document',
  });
  // The exact ID was JUST deleted (manual cleanup, console testing) and
  // Google's own deletion process for that ID can take up to a couple of
  // hours to finish — confirmed live 2026-08-06 ("please wait for deletion
  // to complete before recreating with the same ID"). Waiting isn't
  // acceptable mid-migration, so retry ONCE with a fresh, differently-named
  // ID instead of fighting Google's own cleanup window. Truncate the base
  // (not just append) so the suffix survives sanitizeDataStoreId's 63-char cap.
  if (created.beingDeleted) {
    const suffix = `-r${Date.now().toString(36)}`;
    dataStoreId = dataStoreId.slice(0, 63 - suffix.length) + suffix;
    created = await createDataStore(project, saToken, {
      dataStoreId,
      displayName: `${file.name} (ADK file grounding — ${agentSourceId})`,
      kind: 'document',
    });
  }
  if (!created.created && !created.alreadyExists) {
    return { attempted: 1, succeeded: 0, failed: 1, dataStoreId, error: created.error };
  }

  const bucket = process.env.ADK_STAGING_BUCKET || `${project}-adk-staging`;
  const bucketReady = await ensureBucket(saToken, project, bucket.replace(/^gs:\/\//, ''));
  if (!bucketReady.ok) {
    return { attempted: 1, succeeded: 0, failed: 1, dataStoreId, error: `staging bucket: ${bucketReady.error}` };
  }

  const objectName = `knowledge-files/${agentSourceId}/${file.name}`;
  const up = await uploadBytesToGcs(saToken, bucket.replace(/^gs:\/\//, ''), objectName, file.bytes, file.mimeType);
  if (!up.ok || !up.gcsUri) {
    return { attempted: 1, succeeded: 0, failed: 1, dataStoreId, error: `GCS upload failed: ${up.error}` };
  }

  const imp = await importDocumentsFromGcs(project, saToken, dataStoreId, [up.gcsUri]);
  if (!imp.started || !imp.operationName) {
    return { attempted: 1, succeeded: 0, failed: 1, dataStoreId, error: imp.error ?? 'import did not start' };
  }

  // This is the uploaded-file path that reported a successfully indexed PDF as `lost`
  // (2026-08-07). Confirm against the store before believing the operation's counters.
  const recon = await awaitImport(saToken, imp.operationName, 1, {
    verifyIn: { project, dataStoreId },
  });
  return {
    attempted: 1,
    succeeded: recon.succeeded,
    failed: recon.failed,
    dataStoreId,
    resourcePath: recon.succeeded ? dataStoreResourcePath(project, dataStoreId) : undefined,
    error: recon.failureSamples[0],
  };
}

export interface SharePointFileResult {
  attempted: number;
  succeeded: number;
  failed: number;
  error?: string;
  /** Set when dryRun=true and every check up to (not including) the actual
   *  Gemini upload passed — proves the pipeline would work without writing
   *  anything to the live agent. */
  dryRunWouldSucceed?: boolean;
  bytesFetched?: number;
  contentType?: string;
  alreadyAttached?: boolean;
}

/**
 * Executes the SharePoint/OneDrive copy-mode workaround for a single,
 * ALREADY-RESOLVED drive item — the caller is responsible for resolving it
 * first, either from a manually-supplied "Knowledge URL"
 * (graphFiles.resolveShareUrl) or from a human-confirmed search-and-suggest
 * candidate (graphSearch.findCandidates). This function never searches or
 * guesses on its own — by the time it's called, which file to fetch is
 * already certain.
 *
 * Reuses the SAME agentFiles direct-upload mechanism as plain local uploads
 * (orchestrator.ts's attachKnowledgeFiles) — attaches straight onto the
 * agent, no Google Cloud Storage staging and no separate searchable data
 * store required. That data-store route exists in geminiDataStore.ts and
 * remains a legitimate option for a future "one big searchable corpus"
 * feature, but for "get this specific file onto this specific agent" it's
 * unnecessary complexity: agentFiles already does the job with one fewer
 * moving part and no extra infrastructure (no GCS_BUCKET requirement).
 *
 * Idempotent: skips upload if a file with the same name is already attached
 * to the agent (same check attachKnowledgeFiles already uses) — re-running
 * with the same file is a no-op, not a duplicate.
 */
export async function migrateSharePointDriveItem(
  dest: GeminiDestination,
  saToken: string,
  graphToken: string,
  agentId: string,
  item: DriveItemRef,
  dryRun = false,
): Promise<SharePointFileResult> {
  const existing = readAgentFiles(await getAgent(dest, saToken, agentId));
  if (existing.some((f) => f.fileName === item.name)) {
    return { attempted: 1, succeeded: 0, failed: 0, alreadyAttached: true }; // already attached — nothing to do
  }

  const bytes = await downloadDriveItemBytes(graphToken, item);
  if (!bytes) {
    return { attempted: 1, succeeded: 0, failed: 1, error: `resolved "${item.name}" but downloading its content failed` };
  }

  if (dryRun) {
    // Everything up to the actual write is proven — the real run only adds
    // the upload+attach calls, which are the same already-proven mechanism
    // the working local-upload path uses.
    return {
      attempted: 1,
      succeeded: 0,
      failed: 0,
      dryRunWouldSucceed: true,
      bytesFetched: bytes.bytes.length,
      contentType: bytes.contentType,
    };
  }

  const up = await uploadAgentFile(dest, saToken, agentId, {
    fileName: item.name,
    mimeType: mimeTypeForFile(item.name, bytes.contentType),
    bytes: bytes.bytes,
  });
  if (!up.ok) {
    return { attempted: 1, succeeded: 0, failed: 1, error: `Gemini upload failed: ${up.error}` };
  }
  const ref = (up.raw as { agentFile?: AgentFile }).agentFile;
  if (!ref?.name) {
    return { attempted: 1, succeeded: 0, failed: 1, error: 'uploaded but Gemini returned no file reference' };
  }

  const res = await updateAgentFiles(dest, saToken, agentId, [...existing, ref]);
  if (!res.ok) {
    return { attempted: 1, succeeded: 0, failed: 1, error: `attaching to agent failed: ${res.error}` };
  }
  return { attempted: 1, succeeded: 1, failed: 0 };
}
