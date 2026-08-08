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

export interface TableSearchTarget {
  entitySetName: string;
  primaryKeyAttr: string;
}

export interface TableSearchResolution {
  target: TableSearchTarget | null;
  /** True when the dvtablesearch record exists but has no target table
   *  selected in Copilot Studio — a fact about the source agent, not an
   *  extraction failure (there is genuinely nothing to migrate). */
  unconfigured: boolean;
}

/**
 * "Dataverse table search" knowledge sources (Copilot Studio's "connect an
 * existing Dataverse table" knowledge type) don't capture their target table
 * directly in the bot's YAML — what we capture is the NAME of a `dvtablesearch`
 * config record (e.g. "FAQEntry_uPI4VpDKvs4NXzz7WimSu"), which must be joined
 * through `dvtablesearchentity` (child row, lookup `_dvtablesearch_value`) to
 * find the real `entitylogicalname`. Confirmed live 2026-08-07 against a real
 * agent — the previous code treated the dvtablesearch NAME as if it already
 * WERE the target's EntitySetName and queried EntityDefinitions with it
 * directly, which can never match (it's an arbitrary generated name, not a
 * real Dataverse EntitySetName) — every table-search source failed with a
 * misleading "EntityDefinitions lookup failed" error even when fully configured.
 */
export async function resolveTableSearchTarget(
  url: string,
  token: string,
  dvTableSearchName: string,
): Promise<TableSearchResolution> {
  const fail: TableSearchResolution = { target: null, unconfigured: false };

  const searchRes = await fetch(
    API(url, `dvtablesearchs?$filter=name eq '${dvTableSearchName}'&$select=dvtablesearchid`),
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  if (!searchRes.ok) {
    logger.warn({ status: searchRes.status, dvTableSearchName }, 'dvtablesearch lookup failed');
    return fail;
  }
  const searchJson = (await searchRes.json()) as { value?: { dvtablesearchid?: string }[] };
  const dvTableSearchId = searchJson.value?.[0]?.dvtablesearchid;
  if (!dvTableSearchId) return fail;

  const entityRes = await fetch(
    API(
      url,
      `dvtablesearchentities?$filter=_dvtablesearch_value eq ${dvTableSearchId}&$select=entitylogicalname`,
    ),
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  if (!entityRes.ok) {
    logger.warn({ status: entityRes.status, dvTableSearchId }, 'dvtablesearchentity lookup failed');
    return fail;
  }
  const entityJson = (await entityRes.json()) as { value?: { entitylogicalname?: string }[] };
  const logicalName = entityJson.value?.[0]?.entitylogicalname;
  if (!logicalName) return { target: null, unconfigured: true };

  const defRes = await fetch(
    API(url, `EntityDefinitions?$filter=LogicalName eq '${logicalName}'&$select=EntitySetName,PrimaryIdAttribute`),
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
  );
  if (!defRes.ok) {
    logger.warn({ status: defRes.status, logicalName }, 'EntityDefinitions lookup by LogicalName failed');
    return fail;
  }
  const defJson = (await defRes.json()) as { value?: { EntitySetName?: string; PrimaryIdAttribute?: string }[] };
  const def = defJson.value?.[0];
  if (!def?.EntitySetName || !def?.PrimaryIdAttribute) return fail;
  return { target: { entitySetName: def.EntitySetName, primaryKeyAttr: def.PrimaryIdAttribute }, unconfigured: false };
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
