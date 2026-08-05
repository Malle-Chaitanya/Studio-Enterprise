import { logger } from '../logger.js';
import type { BqSchemaField } from './dataverseTableSchema.js';

/**
 * Plain-REST BigQuery operations for the Dataverse-snapshot large-table path
 * (see knowledgeDataStoreExecutor.ts's `runBigQuerySnapshot`). Same convention
 * as gcsUpload.ts — no `@google-cloud/bigquery` dependency, reuses the SA's
 * existing `cloud-platform` scope.
 *
 * Every "ensure" function is idempotent (check-then-create, 409 = already
 * exists) so re-running a migration never fails on "already there" and never
 * duplicates a dataset/table.
 */

interface OkResult {
  ok: boolean;
  error?: string;
}

/**
 * Check whether the BigQuery API is enabled on the customer's project, and
 * opportunistically try to enable it if not. Best-effort: a customer whose SA
 * grant doesn't include `serviceusage.services.enable` will get `ok: false`
 * here — callers must treat that as a graceful `needs-review` fidelity note,
 * never a blocked migration (same posture as adkDeployer's
 * ensureReasoningEngineDiscoveryAccess).
 */
export async function ensureBigQueryApiEnabled(saToken: string, project: string): Promise<OkResult> {
  const checkRes = await fetch(
    `https://serviceusage.googleapis.com/v1/projects/${project}/services/bigquery.googleapis.com`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  if (checkRes.ok) {
    const json = (await checkRes.json()) as { state?: string };
    if (json.state === 'ENABLED') return { ok: true };
  }
  const enableRes = await fetch(
    `https://serviceusage.googleapis.com/v1/projects/${project}/services/bigquery.googleapis.com:enable`,
    { method: 'POST', headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' }, body: '{}' },
  );
  if (!enableRes.ok) {
    const text = await enableRes.text();
    return { ok: false, error: `enable bigquery.googleapis.com ${enableRes.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

/** Ensure a BigQuery dataset exists (idempotent) — one dataset per Gemini project, not per agent. */
export async function ensureBqDataset(
  saToken: string,
  project: string,
  datasetId: string,
  location: string,
): Promise<OkResult> {
  const check = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (check.ok) return { ok: true };
  const create = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ datasetReference: { projectId: project, datasetId }, location }),
  });
  if (!create.ok) {
    const text = await create.text();
    if (create.status === 409 || text.includes('Already Exists')) return { ok: true };
    return { ok: false, error: `${create.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

/**
 * Ensure a BigQuery table exists with the given schema. If it already exists,
 * best-effort PATCH to add any new (nullable) columns — additive only; never
 * attempts to remove or retype a column, so a failed patch (e.g. an
 * incompatible change) is logged and swallowed, not fatal.
 */
export async function ensureBqTable(
  saToken: string,
  project: string,
  datasetId: string,
  tableId: string,
  schema: BqSchemaField[],
): Promise<OkResult> {
  const tableUrl = `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}/tables/${tableId}`;
  const check = await fetch(tableUrl, { headers: { Authorization: `Bearer ${saToken}` } });
  if (check.ok) {
    const patch = await fetch(tableUrl, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ schema: { fields: schema } }),
    });
    if (!patch.ok) {
      logger.warn(
        { status: patch.status, project, datasetId, tableId },
        'BigQuery table schema patch failed (non-fatal — existing columns kept as-is)',
      );
    }
    return { ok: true };
  }
  const create = await fetch(
    `https://bigquery.googleapis.com/bigquery/v2/projects/${project}/datasets/${datasetId}/tables`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tableReference: { projectId: project, datasetId, tableId },
        schema: { fields: schema },
      }),
    },
  );
  if (!create.ok) {
    const text = await create.text();
    if (create.status === 409 || text.includes('Already Exists')) return { ok: true };
    return { ok: false, error: `${create.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

export interface LoadJobResult {
  started: boolean;
  jobId?: string;
  error?: string;
}

/**
 * Load rows into a BigQuery table via a load job (NDJSON, WRITE_TRUNCATE —
 * every run re-snapshots the table cleanly, no accumulation across reruns).
 * A load job (not streaming inserts) avoids the streaming-buffer consistency
 * lag and is cheaper for a one-shot migration snapshot.
 */
export async function loadRowsToBqTable(
  saToken: string,
  project: string,
  datasetId: string,
  tableId: string,
  rows: Record<string, unknown>[],
): Promise<LoadJobResult> {
  const ndjson = rows.map((r) => JSON.stringify(r)).join('\n');
  const boundary = `csge_bq_load_${Math.random().toString(36).slice(2)}`;
  const metadata = {
    configuration: {
      load: {
        destinationTable: { projectId: project, datasetId, tableId },
        sourceFormat: 'NEWLINE_DELIMITED_JSON',
        writeDisposition: 'WRITE_TRUNCATE',
      },
    },
  };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${ndjson}\r\n--${boundary}--`;

  const res = await fetch(`https://www.googleapis.com/upload/bigquery/v2/projects/${project}/jobs?uploadType=multipart`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body,
  });
  if (!res.ok) {
    const text = await res.text();
    return { started: false, error: `${res.status}: ${text.slice(0, 200)}` };
  }
  const json = (await res.json()) as { jobReference?: { jobId?: string } };
  const jobId = json.jobReference?.jobId;
  if (!jobId) return { started: false, error: 'load job accepted but returned no jobId' };
  return { started: true, jobId };
}

export interface BqJobOutcome {
  done: boolean;
  ok: boolean;
  error?: string;
}

/** Poll a BigQuery job until DONE (or the poll budget runs out). */
export async function awaitBqJob(
  saToken: string,
  project: string,
  jobId: string,
  { maxPolls = 30, intervalMs = 2000 } = {},
): Promise<BqJobOutcome> {
  for (let i = 0; i < maxPolls; i++) {
    const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${project}/jobs/${jobId}`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    if (res.ok) {
      const json = (await res.json()) as { status?: { state?: string; errorResult?: { message?: string } } };
      if (json.status?.state === 'DONE') {
        return json.status.errorResult
          ? { done: true, ok: false, error: json.status.errorResult.message }
          : { done: true, ok: true };
      }
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { done: false, ok: false, error: `load job did not finish within ${maxPolls * intervalMs}ms` };
}
