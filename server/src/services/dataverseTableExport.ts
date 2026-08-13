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
/**
 * Display name → EntitySetName, built once per environment.
 *
 * A Dataverse knowledge source records NOTHING usable as a table reference. Live
 * (2026-08-07) the whole source body is:
 *
 *     kind: DataverseStructuredSearchSource
 *     skillConfiguration: FAQEntry_CFICPProfile_YDjONHProUWi_RE5Pmyu7
 *
 * — an opaque key made of the tables' display names concatenated with a random
 * suffix. Passing it to EntityDefinitions produced "could not resolve … as a
 * Dataverse table" and the snapshot indexed 0 rows. The only real table identity
 * lives in the component's DISPLAY NAME ("FAQ Entry, CF ICP Profile"), which is
 * comma-separated because one source can cover several tables — the same shape as
 * Confluence's multi-space sources.
 *
 * DisplayName is a localized label, so it cannot be filtered server-side in OData;
 * the map is fetched once per environment and matched in memory.
 */
const entityMapCache = new Map<string, Promise<Map<string, string>>>();

async function buildEntityDisplayNameMap(url: string, token: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const path = 'EntityDefinitions?$select=LogicalName,EntitySetName,DisplayName';
  try {
    const res = await fetch(API(url, path), {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) {
      logger.warn({ status: res.status }, 'Dataverse EntityDefinitions listing failed');
      return map;
    }
    const json = (await res.json()) as {
      value?: Array<{
        LogicalName?: string;
        EntitySetName?: string;
        DisplayName?: { UserLocalizedLabel?: { Label?: string } | null };
      }>;
    };
    for (const e of json.value ?? []) {
      if (!e.EntitySetName) continue;
      const label = e.DisplayName?.UserLocalizedLabel?.Label;
      // Index by display name, logical name and a space-stripped form, so
      // "FAQ Entry", "faqentry" and "cr88d_faqentry" all resolve.
      if (label) {
        map.set(label.toLowerCase(), e.EntitySetName);
        map.set(label.replace(/\s+/g, '').toLowerCase(), e.EntitySetName);
      }
      if (e.LogicalName) map.set(e.LogicalName.toLowerCase(), e.EntitySetName);
      map.set(e.EntitySetName.toLowerCase(), e.EntitySetName);
    }
  } catch (err) {
    logger.warn({ err }, 'Dataverse EntityDefinitions listing threw');
  }
  return map;
}

/**
 * Resolve the tables a Dataverse knowledge source refers to.
 *
 * `sourceName` is the component display name ("FAQ Entry, CF ICP Profile");
 * `references` are whatever extraction captured, which may include a usable entity
 * set name on other schemas. Returns every table that resolves — one source can
 * name several — and an empty array when none do, so the caller reports honestly
 * instead of snapshotting nothing and calling it success.
 */
export async function resolveDataverseTables(
  url: string,
  token: string,
  sourceName: string,
  references: string[] = [],
): Promise<{ entitySetNames: string[]; unresolved: string[] }> {
  let map = entityMapCache.get(url);
  if (!map) {
    map = buildEntityDisplayNameMap(url, token);
    entityMapCache.set(url, map);
  }
  const lookup = await map;

  const entitySetNames: string[] = [];
  const unresolved: string[] = [];
  const push = (hit: string | undefined, raw: string) => {
    if (hit && !entitySetNames.includes(hit)) entitySetNames.push(hit);
    else if (!hit && !unresolved.includes(raw)) unresolved.push(raw);
  };

  // A reference that already IS an entity set name wins — other schemas record it.
  for (const ref of references) {
    const direct = lookup.get(ref.trim().toLowerCase());
    if (direct) push(direct, ref);
  }
  if (entitySetNames.length) return { entitySetNames, unresolved: [] };

  // Otherwise fall back to the display name, which may name several tables.
  for (const part of sourceName.split(',').map((p) => p.trim()).filter(Boolean)) {
    push(lookup.get(part.toLowerCase()) ?? lookup.get(part.replace(/\s+/g, '').toLowerCase()), part);
  }
  return { entitySetNames, unresolved };
}

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
  /** Every table resolved from the dvtablesearch -> dvtablesearchentity join.
   *  One dvtablesearch record can name SEVERAL tables ("FAQ Entry, CF ICP
   *  Profile" is two) — each gets its own entry here so the caller can snapshot
   *  each into its own structured data store (different schemas cannot share
   *  one). Empty when the search record itself didn't resolve or none of its
   *  linked entities resolved to a real table. */
  targets: TableSearchTarget[];
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
 *
 * The join can return MORE THAN ONE `dvtablesearchentity` row — one dvtablesearch
 * record naming several tables, same shape as Confluence's multi-space sources.
 * An earlier version of this resolver read only the first row (confirmed live
 * 2026-08-12: a two-table source "FAQ Entry, CF ICP Profile" silently snapshotted
 * only one), so every linked entity is resolved here, not just the first.
 */
export async function resolveTableSearchTarget(
  url: string,
  token: string,
  dvTableSearchName: string,
): Promise<TableSearchResolution> {
  const fail: TableSearchResolution = { targets: [], unconfigured: false };

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
  // One dvtablesearch can link several entities — dedupe in case Copilot Studio
  // ever writes the same table twice, and drop rows with no logical name.
  const logicalNames = [
    ...new Set((entityJson.value ?? []).map((e) => e.entitylogicalname).filter((n): n is string => Boolean(n))),
  ];
  if (!logicalNames.length) return { targets: [], unconfigured: true };

  const targets: TableSearchTarget[] = [];
  for (const logicalName of logicalNames) {
    const defRes = await fetch(
      API(url, `EntityDefinitions?$filter=LogicalName eq '${logicalName}'&$select=EntitySetName,PrimaryIdAttribute`),
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
    );
    if (!defRes.ok) {
      // One bad table in a multi-table source must not cost the others their
      // resolution — log and continue rather than aborting the whole source.
      logger.warn({ status: defRes.status, logicalName }, 'EntityDefinitions lookup by LogicalName failed');
      continue;
    }
    const defJson = (await defRes.json()) as { value?: { EntitySetName?: string; PrimaryIdAttribute?: string }[] };
    const def = defJson.value?.[0];
    if (!def?.EntitySetName || !def?.PrimaryIdAttribute) continue;
    targets.push({ entitySetName: def.EntitySetName, primaryKeyAttr: def.PrimaryIdAttribute });
  }
  return { targets, unconfigured: false };
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
