import type { GeminiDestination, KnowledgeSourceIR } from '../types.js';
import { resolvePrimaryKey, exportTableRows } from './dataverseTableExport.js';
import { createDataStore, importStructuredInline, awaitImport, attachDataStoreToEngine } from './geminiDataStore.js';
import { sanitizeDataStoreId } from './knowledgePlanner.js';

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

export interface DataverseSnapshotResult {
  attempted: number;
  succeeded: number;
  failed: number;
  dataStoreId?: string;
  error?: string;
  failureSamples?: string[];
}

export async function migrateDataverseSnapshot(
  dest: GeminiDestination,
  saToken: string,
  dvToken: string,
  envUrl: string,
  agentSourceId: string,
  source: KnowledgeSourceIR,
): Promise<DataverseSnapshotResult> {
  const entitySetName = (source.references?.[0] ?? source.reference ?? '').trim();
  if (!entitySetName) {
    return { attempted: 0, succeeded: 0, failed: 0, error: 'no table reference captured for this source' };
  }

  const pk = await resolvePrimaryKey(envUrl, dvToken, entitySetName);
  if (!pk) {
    return {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      error: `could not resolve "${entitySetName}" as a Dataverse table (EntityDefinitions lookup failed)`,
    };
  }

  const rows = await exportTableRows(envUrl, dvToken, entitySetName, pk);
  if (!rows.length) {
    return { attempted: 0, succeeded: 0, failed: 0, error: `table "${entitySetName}" returned no rows` };
  }

  const dataStoreId = sanitizeDataStoreId(`${agentSourceId}-tbl-${entitySetName}`);
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

  // ENGINE-SCOPED attach (see geminiDataStore.ts) — the store becomes
  // available to every agent in the app, not just this one. Acceptable for a
  // per-tenant engine; flagged here since it's the same caveat as the
  // existing website/document data-store attach path.
  await attachDataStoreToEngine(dest, saToken, dataStoreId);

  return { attempted: rows.length, succeeded, failed, dataStoreId, failureSamples: failureSamples.slice(0, 5) };
}
