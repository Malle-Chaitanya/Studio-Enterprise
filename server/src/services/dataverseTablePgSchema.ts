import {
  classifyAttribute,
  flattenedNoteFor,
  type ColumnKind,
  type DataverseAttributeDef,
} from './dataverseTableSchema.js';

/**
 * Dataverse → Cloud SQL (PostgreSQL) schema mapping for the full-tenant-cutover live-tool
 * path (see services/cloudSqlMigration.ts). Sibling to dataverseTableSchema.ts's BigQuery
 * mapping — same Dataverse-type classification (imported, not re-derived, so the two
 * destinations never silently disagree about what kind of column an attribute becomes),
 * different column TYPES because Postgres and BigQuery don't share a type system.
 *
 * Type mapping (Dataverse AttributeType → Postgres column(s)):
 *   String / Memo / Uniqueidentifier → TEXT
 *   DateTime                          → TIMESTAMPTZ
 *   Boolean                           → BOOLEAN
 *   Integer / BigInt                  → BIGINT
 *   Decimal / Double                  → NUMERIC
 *   Money                              → NUMERIC + "<attr>_formatted" TEXT
 *   Lookup / Customer / Owner / PartyList → TEXT (guid) + "<attr>_name" TEXT
 *   Picklist / State / Status (choice) → INTEGER (raw) + "<attr>_label" TEXT
 *   MultiSelectPicklist                → TEXT (raw, stringified) + "<attr>_label" TEXT
 *   anything else (fallback)           → TEXT (JSON.stringify), flagged via flattenedNotes
 *
 * Same fidelity posture as the BigQuery path: a lookup/choice/money flattening is a real
 * loss (the live relationship/row-level-security semantics don't survive), never silent.
 */

export interface PgColumn {
  name: string;
  type: 'TEXT' | 'TIMESTAMPTZ' | 'BOOLEAN' | 'BIGINT' | 'INTEGER' | 'NUMERIC';
}

interface ColumnPlanEntry {
  attr: string;
  kind: ColumnKind;
  columns: PgColumn[];
}

export interface PgSchemaResult {
  /** Ordered columns, `id` (the Dataverse primary key) always first. */
  columns: PgColumn[];
  plan: ColumnPlanEntry[];
  flattenedNotes: string[];
}

function pgColumnsFor(attr: string, kind: ColumnKind): PgColumn[] {
  switch (kind) {
    case 'string':
      return [{ name: attr, type: 'TEXT' }];
    case 'timestamp':
      return [{ name: attr, type: 'TIMESTAMPTZ' }];
    case 'boolean':
      return [{ name: attr, type: 'BOOLEAN' }];
    case 'integer':
      return [{ name: attr, type: 'BIGINT' }];
    case 'numeric':
      return [{ name: attr, type: 'NUMERIC' }];
    case 'money':
      return [
        { name: attr, type: 'NUMERIC' },
        { name: `${attr}_formatted`, type: 'TEXT' },
      ];
    case 'lookup':
      return [
        { name: attr, type: 'TEXT' },
        { name: `${attr}_name`, type: 'TEXT' },
      ];
    case 'choice':
      return [
        { name: attr, type: 'INTEGER' },
        { name: `${attr}_label`, type: 'TEXT' },
      ];
    case 'multichoice':
      return [
        { name: attr, type: 'TEXT' },
        { name: `${attr}_label`, type: 'TEXT' },
      ];
    case 'fallback':
      return [{ name: attr, type: 'TEXT' }];
  }
}

/** PURE: build the Postgres column list + row-shaping plan for a table. `id` (the primary
 *  key) is always the leading column, matching exportTableRowsForBigQuery's row shape
 *  (reused as-is for Postgres too — it's already a plain, destination-agnostic object). */
export function buildPgSchema(attrs: DataverseAttributeDef[], primaryKeyAttr: string): PgSchemaResult {
  const idColumn: PgColumn = { name: 'id', type: 'TEXT' };
  const plan: ColumnPlanEntry[] = [];
  const flattenedNotes: string[] = [];

  for (const a of attrs) {
    if (a.LogicalName === primaryKeyAttr) continue; // already represented as `id`
    const kind = classifyAttribute(a.AttributeType);
    const columns = pgColumnsFor(a.LogicalName, kind);
    plan.push({ attr: a.LogicalName, kind, columns });
    const note = flattenedNoteFor(a.LogicalName, kind);
    if (note) flattenedNotes.push(note);
  }

  const columns = [idColumn, ...plan.flatMap((p) => p.columns)];
  return { columns, plan, flattenedNotes };
}

/** One `CREATE TABLE IF NOT EXISTS` statement — quoted identifiers throughout (Dataverse
 *  attribute names are safe SQL identifiers in practice, but quoting costs nothing and
 *  avoids a reserved-word collision silently breaking a customer's specific table). */
export function pgCreateTableSql(table: string, columns: PgColumn[]): string {
  const cols = columns.map((c) => `"${c.name}" ${c.type}${c.name === 'id' ? ' PRIMARY KEY' : ''}`).join(', ');
  return `CREATE TABLE IF NOT EXISTS "${table}" (${cols})`;
}
