import { logger } from '../logger.js';

/**
 * Dataverse table row export — the read side of the Dataverse-table→Gemini
 * structured-data-store snapshot (see knowledgeDataStoreExecutor.ts). Only
 * used for sources the classifier already screened as `dataverse-snapshot`
 * (reference/catalog tables) — sensitive/transactional tables are routed to
 * `rebuild-as-tool` instead and never reach this module.
 */

const API = (url: string, path: string) => `${url}/api/data/v9.2/${path}`;

export interface DataverseRow {
  /** The row's real Dataverse primary key — becomes the Discovery Engine document id. */
  id: string;
  data: Record<string, unknown>;
}

/**
 * Resolve a table's real primary-key attribute via Dataverse's EntityDefinitions
 * metadata (never guessed from the entity-set name — plurals are irregular).
 * This is what makes the snapshot idempotent: importDocuments upserts by id,
 * so a stable, correct id is what stops a re-run from duplicating rows.
 */
export async function resolvePrimaryKey(
  url: string,
  token: string,
  entitySetName: string,
): Promise<string | null> {
  const path = `EntityDefinitions?$filter=EntitySetName eq '${entitySetName}'&$select=PrimaryIdAttribute`;
  const res = await fetch(API(url, path), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    logger.warn({ status: res.status, entitySetName }, 'Dataverse EntityDefinitions lookup failed');
    return null;
  }
  const json = (await res.json()) as { value?: { PrimaryIdAttribute?: string }[] };
  return json.value?.[0]?.PrimaryIdAttribute ?? null;
}

/**
 * Page through a Dataverse table's rows for a structured-data-store snapshot.
 * `entitySetName` is the table's OData entity-set name (plural, lowercase —
 * e.g. "accounts"); `primaryKeyAttr` is its real primary-key column (from
 * `resolvePrimaryKey`), used as each row's stable Discovery Engine document id.
 */
export async function exportTableRows(
  url: string,
  token: string,
  entitySetName: string,
  primaryKeyAttr: string,
  maxRows = 5000,
): Promise<DataverseRow[]> {
  const rows: DataverseRow[] = [];
  let path: string | null = `${entitySetName}?$top=500`;
  while (path && rows.length < maxRows) {
    const res = await fetch(path.startsWith('http') ? path : API(url, path), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      logger.warn({ status: res.status, entitySetName }, 'Dataverse table export failed');
      break;
    }
    const json = (await res.json()) as {
      value?: Record<string, unknown>[];
      '@odata.nextLink'?: string;
    };
    for (const r of json.value ?? []) {
      const idVal = r[primaryKeyAttr];
      rows.push({ id: typeof idVal === 'string' ? idVal : String(rows.length), data: r });
      if (rows.length >= maxRows) break;
    }
    path = json['@odata.nextLink'] ?? null;
  }
  return rows;
}
