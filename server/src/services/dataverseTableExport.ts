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
