/**
 * Dataverse table → Vertex AI Search structured-document transform.
 *
 * The `dataverse-snapshot` strategy: a reference table (e.g. a product catalog)
 * is exported to a STRUCTURED data store rather than rebuilt as a live tool.
 * This module is the PURE core — it turns raw Dataverse rows into structured
 * search documents. The reader (Dataverse Web API) and importer (Discovery
 * Engine) are separate I/O modules.
 *
 * Enterprise guardrails baked in here (why this is safe, not a naive dump):
 *  1. STABLE IDS — each doc id derives from the row's primary key, so a re-run
 *     UPDATES the row instead of duplicating it (idempotent refresh).
 *  2. PROVENANCE + STALENESS — every doc is stamped with its source and the
 *     snapshot timestamp, so a snapshot is never mistaken for live data.
 *  3. COLUMN PROJECTION — include/exclude honored; Dataverse system/@odata
 *     plumbing columns are dropped so only meaningful fields are indexed.
 *
 * Note: sensitivity gating (which tables may be snapshotted at all) lives in the
 * classifier (`looksSensitive`); by the time rows reach here, that decision is
 * already made.
 */

export type DataverseRow = Record<string, unknown>;

/** A Discovery Engine structured Document (JSONL line shape). */
export interface StructuredDoc {
  id: string;
  structData: Record<string, unknown>;
}

export interface SnapshotOptions {
  /** Logical table name (used for provenance + id prefixing). */
  table: string;
  rows: DataverseRow[];
  /** Column holding the row's primary key (stable id source). */
  primaryKey: string;
  /** If set, only these columns are kept (Include options). */
  includeColumns?: string[];
  /** Columns to drop (Exclude options). */
  excludeColumns?: string[];
  /** ISO timestamp of this snapshot — passed in (keeps this function pure). */
  snapshotAt: string;
  /** Provenance string, e.g. "Dataverse:CloudFuze Migration Test/Product". */
  sourceRef: string;
}

/** Dataverse plumbing columns that should never be indexed. */
function isSystemColumn(col: string): boolean {
  return (
    col.startsWith('@odata') ||
    col.endsWith('@OData.Community.Display.V1.FormattedValue') ||
    col.startsWith('_') ||
    /^(createdon|modifiedon|createdby|modifiedby|ownerid|statecode|statuscode|versionnumber|timezoneruleversionnumber|utcconversiontimezonecode|importsequencenumber|overriddencreatedon)$/i.test(col)
  );
}

/** Doc ids: alphanumeric, dash, underscore; ≤63 chars. */
function sanitizeDocId(raw: string): string {
  const id = (raw || '')
    .replace(/[^A-Za-z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return (id || 'row').slice(0, 63).replace(/-$/, '');
}

/** Keep only the columns that should be indexed, honoring include/exclude. */
function projectColumns(
  row: DataverseRow,
  include?: string[],
  exclude?: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const incl = include && include.length ? new Set(include) : null;
  const excl = new Set(exclude ?? []);
  for (const [col, val] of Object.entries(row)) {
    if (isSystemColumn(col)) continue;
    if (incl && !incl.has(col)) continue;
    if (excl.has(col)) continue;
    if (val === null || val === undefined) continue;
    out[col] = val;
  }
  return out;
}

/**
 * Transform Dataverse rows into structured search documents.
 * Rows missing a primary-key value fall back to a positional id so nothing is
 * silently dropped (but the caller should treat that as a data-quality warning).
 */
export function rowsToStructuredDocs(opts: SnapshotOptions): StructuredDoc[] {
  return opts.rows.map((row, i) => {
    const pk = row[opts.primaryKey];
    const rawId = pk !== undefined && pk !== null ? String(pk) : `${opts.table}-row-${i}`;
    const structData = projectColumns(row, opts.includeColumns, opts.excludeColumns);
    // Provenance + staleness stamp (underscored so they don't collide with data).
    structData._source = opts.sourceRef;
    structData._snapshotAt = opts.snapshotAt;
    structData._table = opts.table;
    return { id: sanitizeDocId(rawId), structData };
  });
}

/** Serialize structured docs to newline-delimited JSON for import. */
export function toJsonl(docs: StructuredDoc[]): string {
  return docs.map((d) => JSON.stringify(d)).join('\n');
}

/** Detect duplicate ids (would collide on import) — a data-quality guard. */
export function findDuplicateIds(docs: StructuredDoc[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const d of docs) {
    if (seen.has(d.id)) dupes.add(d.id);
    seen.add(d.id);
  }
  return [...dupes];
}
