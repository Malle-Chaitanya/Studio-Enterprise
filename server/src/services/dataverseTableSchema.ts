import { logger } from '../logger.js';

/**
 * Dataverse → BigQuery schema mapping for the large-table snapshot path (see
 * knowledgeDataStoreExecutor.ts's `runBigQuerySnapshot`). Sibling to
 * dataverseTableExport.ts, not a change to it — the small-table inline path
 * (`exportTableRows`) is live-proven and stays untouched; this module only
 * feeds the new BigQuery route, which needs real column types instead of
 * inline's "whatever JSON came back" struct.
 *
 * Type mapping (Dataverse AttributeType → BigQuery column(s)):
 *   String / Memo / Uniqueidentifier → STRING
 *   DateTime                          → TIMESTAMP
 *   Boolean                           → BOOLEAN
 *   Integer / BigInt                  → INTEGER
 *   Decimal / Double                  → NUMERIC
 *   Money                             → NUMERIC + "<attr>_formatted" STRING
 *   Lookup / Customer / Owner / PartyList (relationship refs)
 *                                      → STRING (guid) + "<attr>_name" STRING
 *   Picklist / State / Status (choice) → INTEGER (raw) + "<attr>_label" STRING
 *   MultiSelectPicklist                → STRING (raw, stringified) + "<attr>_label" STRING
 *   anything else (Virtual, ManagedProperty, …) → STRING (JSON.stringify fallback,
 *   never silently dropped — surfaced as a flattenedNote so the fidelity report
 *   can say a column's real shape wasn't preserved).
 *
 * Lookups/choices lose their relationship semantics here — a lookup becomes a
 * GUID + a display-name string, not a live reference to the target row. That's
 * a real fidelity loss, not a formatting detail, which is why every twin-column
 * case adds a `flattenedNotes` entry instead of mapping silently.
 */

const API = (url: string, path: string) => `${url}/api/data/v9.2/${path}`;

export interface DataverseAttributeDef {
  LogicalName: string;
  AttributeType: string;
}

export type BqFieldType = 'STRING' | 'INTEGER' | 'NUMERIC' | 'BOOLEAN' | 'TIMESTAMP';

export interface BqSchemaField {
  name: string;
  type: BqFieldType;
  mode?: 'REQUIRED' | 'NULLABLE';
}

type ColumnKind =
  | 'string'
  | 'timestamp'
  | 'boolean'
  | 'integer'
  | 'numeric'
  | 'money'
  | 'lookup'
  | 'choice'
  | 'multichoice'
  | 'fallback';

/** One Dataverse attribute's plan for how it becomes 1-2 BigQuery columns. */
interface ColumnPlanEntry {
  attr: string;
  kind: ColumnKind;
  columns: BqSchemaField[];
}

export interface BqSchemaResult {
  schema: BqSchemaField[];
  plan: ColumnPlanEntry[];
  /** Human-readable, per-column fidelity notes — never boilerplate. */
  flattenedNotes: string[];
}

/**
 * Fetch a table's real attribute metadata (logical name + type) in one round
 * trip via $expand — avoids a second EntityDefinitions lookup after
 * resolvePrimaryKey's own call.
 */
export async function resolveTableAttributes(
  url: string,
  token: string,
  entitySetName: string,
): Promise<DataverseAttributeDef[] | null> {
  const path =
    `EntityDefinitions?$filter=EntitySetName eq '${entitySetName}'` +
    `&$select=LogicalName&$expand=Attributes($select=LogicalName,AttributeType)`;
  const res = await fetch(API(url, path), {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    logger.warn({ status: res.status, entitySetName }, 'Dataverse Attributes metadata lookup failed');
    return null;
  }
  const json = (await res.json()) as { value?: { Attributes?: DataverseAttributeDef[] }[] };
  return json.value?.[0]?.Attributes ?? null;
}

function classifyAttribute(attributeType: string): ColumnKind {
  switch (attributeType) {
    case 'String':
    case 'Memo':
    case 'Uniqueidentifier':
      return 'string';
    case 'DateTime':
      return 'timestamp';
    case 'Boolean':
      return 'boolean';
    case 'Integer':
    case 'BigInt':
      return 'integer';
    case 'Decimal':
    case 'Double':
      return 'numeric';
    case 'Money':
      return 'money';
    case 'Lookup':
    case 'Customer':
    case 'Owner':
    case 'PartyList':
      return 'lookup';
    case 'Picklist':
    case 'State':
    case 'Status':
      return 'choice';
    case 'MultiSelectPicklist':
      return 'multichoice';
    default:
      return 'fallback';
  }
}

function columnsFor(attr: string, kind: ColumnKind): BqSchemaField[] {
  switch (kind) {
    case 'string':
      return [{ name: attr, type: 'STRING' }];
    case 'timestamp':
      return [{ name: attr, type: 'TIMESTAMP' }];
    case 'boolean':
      return [{ name: attr, type: 'BOOLEAN' }];
    case 'integer':
      return [{ name: attr, type: 'INTEGER' }];
    case 'numeric':
      return [{ name: attr, type: 'NUMERIC' }];
    case 'money':
      return [
        { name: attr, type: 'NUMERIC' },
        { name: `${attr}_formatted`, type: 'STRING' },
      ];
    case 'lookup':
      return [
        { name: attr, type: 'STRING' },
        { name: `${attr}_name`, type: 'STRING' },
      ];
    case 'choice':
      return [
        { name: attr, type: 'INTEGER' },
        { name: `${attr}_label`, type: 'STRING' },
      ];
    case 'multichoice':
      return [
        { name: attr, type: 'STRING' },
        { name: `${attr}_label`, type: 'STRING' },
      ];
    case 'fallback':
      return [{ name: attr, type: 'STRING' }];
  }
}

function flattenedNoteFor(attr: string, kind: ColumnKind): string | null {
  switch (kind) {
    case 'lookup':
      return `"${attr}" is a lookup — flattened to id + display-name string; the relationship to the target record is not preserved.`;
    case 'choice':
      return `"${attr}" is a choice/optionset — flattened to raw value + label string.`;
    case 'multichoice':
      return `"${attr}" is a multi-select choice — flattened to a stringified value + label string.`;
    case 'money':
      return `"${attr}" is a Money field — kept as NUMERIC plus a separately formatted string (currency symbol not preserved as a typed value).`;
    case 'fallback':
      return `"${attr}" has an unrecognized Dataverse type — stored as a JSON-stringified STRING; its real shape was not preserved.`;
    default:
      return null;
  }
}

/**
 * PURE: build the BigQuery schema + row-shaping plan for a table. The primary
 * key attribute is excluded from the general loop and always emitted as the
 * leading, required `id` column (matching DataverseRow's `id` convention).
 */
export function buildBqSchema(attrs: DataverseAttributeDef[], primaryKeyAttr: string): BqSchemaResult {
  const idField: BqSchemaField = { name: 'id', type: 'STRING', mode: 'REQUIRED' };
  const plan: ColumnPlanEntry[] = [];
  const flattenedNotes: string[] = [];

  for (const a of attrs) {
    if (a.LogicalName === primaryKeyAttr) continue; // already represented as `id`
    const kind = classifyAttribute(a.AttributeType);
    const columns = columnsFor(a.LogicalName, kind);
    plan.push({ attr: a.LogicalName, kind, columns });
    const note = flattenedNoteFor(a.LogicalName, kind);
    if (note) flattenedNotes.push(note);
  }

  const schema = [idField, ...plan.flatMap((p) => p.columns)];
  return { schema, plan, flattenedNotes };
}

/** Shape one raw Dataverse row (with formatted-value annotations) into a flat BigQuery row. */
function shapeRow(
  raw: Record<string, unknown>,
  primaryKeyAttr: string,
  plan: ColumnPlanEntry[],
): Record<string, unknown> {
  const idVal = raw[primaryKeyAttr];
  const out: Record<string, unknown> = { id: typeof idVal === 'string' ? idVal : String(idVal ?? '') };

  const formatted = (attr: string): string | undefined => {
    const v = raw[`${attr}@OData.Community.Display.V1.FormattedValue`];
    return typeof v === 'string' ? v : undefined;
  };

  for (const { attr, kind } of plan) {
    const v = raw[attr];
    if (v === null || v === undefined) continue;
    switch (kind) {
      case 'lookup':
        out[attr] = String(v);
        out[`${attr}_name`] = formatted(attr) ?? null;
        break;
      case 'choice':
        out[attr] = typeof v === 'number' ? v : Number(v);
        out[`${attr}_label`] = formatted(attr) ?? null;
        break;
      case 'multichoice':
        out[attr] = Array.isArray(v) ? JSON.stringify(v) : String(v);
        out[`${attr}_label`] = formatted(attr) ?? null;
        break;
      case 'money':
        out[attr] = typeof v === 'number' ? v : Number(v);
        out[`${attr}_formatted`] = formatted(attr) ?? null;
        break;
      case 'fallback':
        out[attr] = typeof v === 'string' ? v : JSON.stringify(v);
        break;
      default:
        // string / timestamp / boolean / integer / numeric — pass raw value through.
        out[attr] = v;
    }
  }
  return out;
}

/**
 * Page through a Dataverse table's rows, requesting formatted-value
 * annotations (needed for lookup display names, choice labels, and formatted
 * money) and shaping each row to match `buildBqSchema`'s plan exactly.
 * Mirrors exportTableRows' pagination (`@odata.nextLink`, no `$skip` — Dataverse
 * doesn't support it) but is a separate function so the live-proven inline
 * path never has to carry this shaping/annotation overhead.
 */
export async function exportTableRowsForBigQuery(
  url: string,
  token: string,
  entitySetName: string,
  primaryKeyAttr: string,
  plan: ColumnPlanEntry[],
  maxRows: number,
): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  let path: string | null = `${entitySetName}?$top=500`;
  while (path && rows.length < maxRows) {
    const res = await fetch(path.startsWith('http') ? path : API(url, path), {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"',
      },
    });
    if (!res.ok) {
      logger.warn({ status: res.status, entitySetName }, 'Dataverse table export (BigQuery path) failed');
      break;
    }
    const json = (await res.json()) as {
      value?: Record<string, unknown>[];
      '@odata.nextLink'?: string;
    };
    for (const r of json.value ?? []) {
      rows.push(shapeRow(r, primaryKeyAttr, plan));
      if (rows.length >= maxRows) break;
    }
    path = json['@odata.nextLink'] ?? null;
  }
  return rows;
}
