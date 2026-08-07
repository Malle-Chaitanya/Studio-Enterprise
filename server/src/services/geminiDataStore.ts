import { logger } from '../logger.js';
import { reconcileImport, type ImportOperation, type ImportReconciliation } from './importReconcile.js';
import type { GeminiDestination } from '../types.js';
import { geminiWriteLimiter } from './rateLimiter.js';

/**
 * Gemini Enterprise (Discovery Engine v1alpha) data-store operations for
 * knowledge migration: create a data store, import documents (GCS), and poll +
 * reconcile the import operation.
 *
 * Built on the same conventions as gemini.ts (v1alpha host, service-account
 * bearer token, quota backoff). ⚠️ The network calls here require live Google
 * credentials + a Discovery Engine engine to verify end to end; the pure
 * request-building and reconciliation are covered by _test_knowledge_plan.ts.
 */

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const collectionBase = (project: string) =>
  `${HOST}/projects/${project}/locations/global/collections/default_collection`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function withBackoff(fn: () => Promise<Response>, { retries = 6, baseMs = 1000, maxMs = 30000 } = {}): Promise<Response> {
  let attempt = 0;
  while (true) {
    await geminiWriteLimiter.acquire(); // pace writes to avoid 429 bursts
    // A THROWN fetch (ECONNRESET, TLS reset, DNS blip) used to escape this helper
    // entirely, so a single dropped connection aborted a whole migration — observed
    // live 2026-08-07 killing a SharePoint import while polling its operation, after
    // the documents had already uploaded. Network failures are exactly what backoff is
    // for, so they retry on the same schedule as 429/503 and only surface once the
    // retries are exhausted.
    let res: Response;
    try {
      res = await fn();
    } catch (err) {
      if (attempt >= retries) throw err;
      const wait = Math.min(maxMs, baseMs * 2 ** attempt);
      logger.warn(
        { err: (err as Error).message, attempt, wait },
        'Discovery Engine request failed at the network level — retrying',
      );
      await sleep(wait);
      attempt++;
      continue;
    }
    if (res.status !== 429 && res.status !== 503) return res;
    if (res.status === 429) {
      const body = await res.clone().text().catch(() => '');
      if (/RESOURCE_EXHAUSTED|quota exceeded/i.test(body)) {
        logger.warn('Discovery Engine HARD quota (RESOURCE_EXHAUSTED) — not retrying');
        return res;
      }
    }
    if (attempt >= retries) return res;
    const retryAfter = res.headers.get('retry-after');
    let base: number;
    if (retryAfter) {
      const secs = Number(retryAfter);
      base = Number.isFinite(secs) ? secs * 1000 : Math.max(0, new Date(retryAfter).getTime() - Date.now());
    } else {
      base = Math.min(maxMs, baseMs * 2 ** attempt);
    }
    const wait = Math.round(base / 2 + Math.random() * (base / 2)); // equal jitter
    logger.warn({ status: res.status, attempt, wait }, 'Discovery Engine rate limited; backing off');
    await sleep(wait);
    attempt++;
  }
}

export type DataStoreKind = 'document' | 'website' | 'structured';

export interface CreateDataStoreResult {
  created: boolean;
  dataStoreId: string;
  alreadyExists?: boolean;
  error?: string;
}

/**
 * Create a data store. For `document`, an unstructured content store; for
 * `website`, a site-search store seeded with `uris`.
 */
export async function createDataStore(
  project: string,
  saToken: string,
  opts: { dataStoreId: string; displayName: string; kind: DataStoreKind; uris?: string[]; advanced?: boolean },
): Promise<CreateDataStoreResult> {
  const bodyByKind: Record<DataStoreKind, Record<string, unknown>> = {
    website: {
      displayName: opts.displayName,
      industryVertical: 'GENERIC',
      solutionTypes: ['SOLUTION_TYPE_SEARCH'],
      contentConfig: 'PUBLIC_WEBSITE',
    },
    document: {
      displayName: opts.displayName,
      industryVertical: 'GENERIC',
      solutionTypes: ['SOLUTION_TYPE_SEARCH'],
      contentConfig: 'CONTENT_REQUIRED',
    },
    // Structured (tabular) data store — no content files, schema inferred from
    // the imported structData. This is the Dataverse-snapshot target.
    structured: {
      displayName: opts.displayName,
      industryVertical: 'GENERIC',
      solutionTypes: ['SOLUTION_TYPE_SEARCH'],
      contentConfig: 'NO_CONTENT',
    },
  };
  const body = bodyByKind[opts.kind];

  // NOTE: neither tier can be attached to a Gemini Enterprise app/engine
  // (docs/knowledge-sources-migration-playbook.md §4.1 — Google-documented,
  // proven live). Advanced indexing also requires Search Console domain
  // ownership verification we don't control for a customer's site, so the ADK/
  // VertexAiSearchTool grounding path (adkDeployer.ts) deliberately requests
  // BASIC (advanced=false) — sufficient for that tool and needs no verification.
  const query =
    `dataStoreId=${encodeURIComponent(opts.dataStoreId)}` +
    (opts.kind === 'website' && opts.advanced !== false ? '&createAdvancedSiteSearch=true' : '');

  const res = await withBackoff(() =>
    fetch(`${collectionBase(project)}/dataStores?${query}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

  if (res.ok) return { created: true, dataStoreId: opts.dataStoreId };
  const text = await res.text();
  if (res.status === 409 || text.includes('already exists')) {
    return { created: false, dataStoreId: opts.dataStoreId, alreadyExists: true };
  }
  return { created: false, dataStoreId: opts.dataStoreId, error: `${res.status}: ${text.slice(0, 200)}` };
}

/**
 * Whether a data store still actually exists in Discovery Engine — used
 * before trusting a cached "already migrated" record (e.g. adkKnowledgeStores)
 * so a data store deleted out-of-band (manual cleanup, console testing) is
 * detected as stale instead of silently reused. A dangling cached resourcePath
 * would otherwise get baked into a new ADK deploy's VertexAiSearchTool,
 * producing an agent that reports `mapped` in the fidelity note but can never
 * actually retrieve anything — the exact silent-overclaim this project's
 * honesty principle exists to prevent.
 */
export async function dataStoreExists(project: string, saToken: string, dataStoreId: string): Promise<boolean> {
  const res = await fetch(`${collectionBase(project)}/dataStores/${encodeURIComponent(dataStoreId)}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  return res.ok;
}

/**
 * Add a target site (URL pattern) to a PUBLIC_WEBSITE data store so Gemini
 * crawls/indexes it. `uriPattern` e.g. "learn.microsoft.com/en-us/dynamics365/*".
 */
export async function addTargetSite(
  project: string,
  saToken: string,
  dataStoreId: string,
  uriPattern: string,
): Promise<{ ok: boolean; error?: string }> {
  const url = `${collectionBase(project)}/dataStores/${dataStoreId}/siteSearchEngine/targetSites`;
  const res = await withBackoff(() =>
    fetch(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ providedUriPattern: uriPattern, type: 'INCLUDE', exactMatch: false }),
    }),
  );
  if (!res.ok) return { ok: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
  return { ok: true };
}

/** Full Discovery Engine resource path a data store is referenced by (e.g. ADK's VertexAiSearchTool). */
export function dataStoreResourcePath(project: string, dataStoreId: string): string {
  return `projects/${project}/locations/global/collections/default_collection/dataStores/${dataStoreId}`;
}

/**
 * Attach a data store to the engine by appending its id to engine.dataStoreIds
 * (idempotent). This is ENGINE-SCOPED — the store becomes available to every
 * agent in the app, which is how Agentspace grounds on search data.
 */
export async function attachDataStoreToEngine(
  dest: GeminiDestination,
  saToken: string,
  dataStoreId: string,
): Promise<{ ok: boolean; error?: string; dataStoreIds?: string[] }> {
  const engineUrl = `${collectionBase(dest.project)}/engines/${dest.engine}`;
  const getRes = await fetch(engineUrl, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!getRes.ok) return { ok: false, error: `get engine ${getRes.status}` };
  const eng = (await getRes.json()) as { dataStoreIds?: string[] };
  const ids = eng.dataStoreIds ?? [];
  if (ids.includes(dataStoreId)) return { ok: true, dataStoreIds: ids };

  const merged = [...ids, dataStoreId];
  const patch = await withBackoff(() =>
    fetch(`${engineUrl}?updateMask=dataStoreIds`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ dataStoreIds: merged }),
    }),
  );
  if (!patch.ok) return { ok: false, error: `patch engine ${patch.status}: ${(await patch.text()).slice(0, 200)}` };
  return { ok: true, dataStoreIds: merged };
}

/**
 * Kick off an ImportDocuments from GCS. Returns the operation name to poll.
 * `gcsUris` point at the files already uploaded to a bucket (the copy step).
 */
export async function importDocumentsFromGcs(
  project: string,
  saToken: string,
  dataStoreId: string,
  gcsUris: string[],
): Promise<{ started: boolean; operationName?: string; error?: string }> {
  const branch = `${collectionBase(project)}/dataStores/${dataStoreId}/branches/default_branch`;
  const res = await withBackoff(() =>
    fetch(`${branch}/documents:import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        gcsSource: { inputUris: gcsUris, dataSchema: 'content' },
        reconciliationMode: 'INCREMENTAL',
      }),
    }),
  );
  if (!res.ok) return { started: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
  const json = (await res.json()) as { name?: string };
  return { started: true, operationName: json.name };
}

/**
 * Import structured (tabular) documents inline — used by the Dataverse-snapshot
 * path. Each doc is `{ id, structData }`. Discovery Engine caps an inline import
 * at 100 documents/request, so callers must chunk larger tables.
 * ⚠️ Requires live credentials + a structured data store to verify.
 */
export async function importStructuredInline(
  project: string,
  saToken: string,
  dataStoreId: string,
  docs: { id: string; structData: Record<string, unknown> }[],
): Promise<{ started: boolean; operationName?: string; error?: string }> {
  if (docs.length > 100) {
    return { started: false, error: `inline import capped at 100 docs/request; got ${docs.length} — chunk first` };
  }
  const branch = `${collectionBase(project)}/dataStores/${dataStoreId}/branches/default_branch`;
  const res = await withBackoff(() =>
    fetch(`${branch}/documents:import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        inlineSource: { documents: docs.map((d) => ({ id: d.id, structData: d.structData })) },
        reconciliationMode: 'INCREMENTAL', // upsert by id → idempotent refresh
      }),
    }),
  );
  if (!res.ok) return { started: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
  const json = (await res.json()) as { name?: string };
  return { started: true, operationName: json.name };
}

/**
 * Import structured (tabular) documents FROM a BigQuery table — the
 * large-table counterpart to importStructuredInline (no 100-doc/request cap;
 * one job handles the whole table). Used by the Dataverse-snapshot path when
 * a table's row count exceeds config.BQ_SNAPSHOT_ROW_THRESHOLD.
 * `reconciliationMode: 'FULL'` is intentional here (not 'INCREMENTAL' like the
 * inline path) — every run re-snapshots the source table fully via a
 * WRITE_TRUNCATE BigQuery load first, so FULL is the semantically correct
 * pairing. NOTE: deletion behavior (does FULL actually remove rows absent
 * from the new snapshot) has not been live-verified — treat as unconfirmed
 * until checked; only insert/update is proven.
 */
export async function importStructuredFromBigQuery(
  project: string,
  saToken: string,
  dataStoreId: string,
  bq: { datasetId: string; tableId: string; idField?: string },
): Promise<{ started: boolean; operationName?: string; error?: string }> {
  const branch = `${collectionBase(project)}/dataStores/${dataStoreId}/branches/default_branch`;
  const res = await withBackoff(() =>
    fetch(`${branch}/documents:import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bigquerySource: { projectId: project, datasetId: bq.datasetId, tableId: bq.tableId, dataSchema: 'custom' },
        reconciliationMode: 'FULL',
        ...(bq.idField ? { autoGenerateIds: false, idField: bq.idField } : { autoGenerateIds: true }),
      }),
    }),
  );
  if (!res.ok) return { started: false, error: `${res.status}: ${(await res.text()).slice(0, 200)}` };
  const json = (await res.json()) as { name?: string };
  return { started: true, operationName: json.name };
}

/** Fetch a long-running operation by name. */
export async function getOperation(saToken: string, operationName: string): Promise<ImportOperation | null> {
  const res = await withBackoff(() =>
    fetch(`${HOST.replace('/v1alpha', '')}/v1alpha/${operationName}`, {
      headers: { Authorization: `Bearer ${saToken}` },
    }),
  );
  if (!res.ok) return null;
  return (await res.json()) as ImportOperation;
}

/**
 * Poll an import operation to completion, then reconcile the TRUTHFUL indexed
 * count from the operation result (not from `attemptedUploads`).
 */
export async function awaitImport(
  saToken: string,
  operationName: string,
  attemptedUploads: number,
  { maxPolls = 60, intervalMs = 5000 } = {},
): Promise<ImportReconciliation> {
  let op: ImportOperation | null = null;
  for (let i = 0; i < maxPolls; i++) {
    op = await getOperation(saToken, operationName);
    if (op?.done) break;
    await sleep(intervalMs);
  }
  return reconcileImport(op, attemptedUploads);
}
