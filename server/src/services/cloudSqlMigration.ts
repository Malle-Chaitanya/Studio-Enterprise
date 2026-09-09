import { logger } from '../logger.js';
import type { AgentToolIR, FidelityNote, GeminiDestination } from '../types.js';
import { resolveTableAttributes, exportTableRowsForBigQuery } from './dataverseTableSchema.js';
import { resolvePrimaryKey } from './dataverseTableExport.js';
import { buildPgSchema } from './dataverseTablePgSchema.js';
import {
  preflightCloudSql,
  ensureCloudSqlApiEnabled,
  ensureCloudSqlInstance,
  ensureDatabase,
  ensureIamDatabaseUser,
  ensureReasoningEngineCloudSqlAccess,
  ensureTableAndUpsertRows,
} from './cloudSqlUpload.js';
import { resolveProjectNumber } from './adkDeployer.js';

/**
 * Full-tenant-cutover bridge: copy one live Dataverse connector tool's backing table into
 * Cloud SQL for PostgreSQL, and return the target the deployed agent's tool should query
 * instead of calling Dataverse live. Only called when `ResolvedPlan.dataverseCutoverMode
 * === 'full-tenant-cutover'` — see orchestrator.ts's Phase 2 per-agent block.
 *
 * A DELIBERATE, documented exception to the two-phase EXTRACT/never-touches-Gemini,
 * INSERT/never-touches-Dataverse boundary (architecture-boundaries.md): this function reads
 * Dataverse AND writes Google in one step, because the copy is a single, non-idempotent-if-
 * split operation that genuinely needs both credentials at once. The exact same exception
 * already exists for services/knowledgeDataStoreExecutor.ts's `migrateDataverseSnapshot` —
 * this function is that same shape, not a new kind of boundary violation. Both credentials
 * (`dvToken`, `saToken`) are already in scope in orchestrator.ts at the point this needs to
 * run, in the same per-agent Phase 2 block as the existing flow-integration step.
 *
 * Idempotent end to end: instance/database/IAM-user provisioning is check-then-create
 * (cloudSqlUpload.ts), and rows are upserted by the Dataverse primary key — re-running a
 * migration refreshes the copy in place, never duplicates rows or provisions a second
 * instance.
 *
 * One Cloud SQL instance per Gemini project (not per agent, not per table) — every
 * Dataverse-tool table across every agent in this project lands in the same instance, each
 * as its own database (named after the entity), matching ensureBqDataset's "one dataset per
 * project" convention.
 */

const INSTANCE_ID = 'csge-dataverse-tables';

export interface CloudSqlMigrationResult {
  ok: boolean;
  cloudSqlTarget?: AgentToolIR['cloudSqlTarget'];
  fidelityNotes: FidelityNote[];
  error?: string;
}

export async function migrateDataverseTableToCloudSql(
  dest: GeminiDestination,
  saToken: string,
  serviceAccountEmail: string,
  dvToken: string,
  envUrl: string,
  tool: AgentToolIR,
): Promise<CloudSqlMigrationResult> {
  // The model-facing name the customer actually gave this tool in Copilot Studio (e.g.
  // "GetClientProfile") — `tool.name` alone is the botcomponent's own internal name, which
  // for a Dataverse "List rows" action defaults to a generic label regardless of what the
  // customer named the tool. Confirmed live 2026-09-08: a deployed "GetClientProfile" tool
  // showed up in the live chat as "Microsoft Dataverse: List Rows From Selected Environment"
  // because every reference below used to read `tool.name` directly — every OTHER
  // tool-naming path in this codebase already prefers displayName (assess.ts,
  // boundToolSpec.ts, mapper.ts, orchestrator.ts's own scopedMcpTools).
  const toolLabel = tool.displayName || tool.name;
  // Fail fast with the exact fix, before any Dataverse read or Cloud SQL provisioning
  // attempt — a real customer's first cutover migration should never be the moment they
  // discover a missing one-time IAM grant, fifteen minutes and a stack trace later.
  const preflight = await preflightCloudSql(saToken, dest.project, serviceAccountEmail);
  if (!preflight.ok) {
    return { ok: false, error: preflight.error, fidelityNotes: [] };
  }

  const entityName = tool.inputs?.find((i) => i.name === 'entityName' && i.source === 'fixed')?.value;
  if (!entityName) {
    return {
      ok: false,
      error: `tool "${toolLabel}" has no fixed entityName input — cannot determine which Dataverse table to copy`,
      fidelityNotes: [],
    };
  }

  const pk = await resolvePrimaryKey(envUrl, dvToken, entityName);
  if (!pk) {
    return { ok: false, error: `could not resolve "${entityName}" as a Dataverse table (EntityDefinitions lookup failed)`, fidelityNotes: [] };
  }
  const attrs = await resolveTableAttributes(envUrl, dvToken, entityName);
  if (!attrs) {
    return { ok: false, error: `could not read column metadata for "${entityName}"`, fidelityNotes: [] };
  }

  const { columns, plan, flattenedNotes } = buildPgSchema(attrs, pk);
  const rows = await exportTableRowsForBigQuery(envUrl, dvToken, entityName, pk, plan, 50_000);
  if (!rows.length) {
    return { ok: false, error: `table "${entityName}" returned no rows`, fidelityNotes: [] };
  }

  const apiEnabled = await ensureCloudSqlApiEnabled(saToken, dest.project);
  if (!apiEnabled.ok) {
    return { ok: false, error: `Cloud SQL Admin API: ${apiEnabled.error}`, fidelityNotes: [] };
  }
  const instance = await ensureCloudSqlInstance(saToken, dest.project, INSTANCE_ID);
  if (!instance.ok) {
    return { ok: false, error: `Cloud SQL instance: ${instance.error}`, fidelityNotes: [] };
  }
  // One database per Dataverse table, named after the entity — same table, same name, on
  // both sides, per the requirement that this migrate "as is," names preserved.
  const database = entityName.toLowerCase();
  const dbResult = await ensureDatabase(saToken, dest.project, INSTANCE_ID, database);
  if (!dbResult.ok) {
    return { ok: false, error: `Cloud SQL database: ${dbResult.error}`, fidelityNotes: [] };
  }
  const userResult = await ensureIamDatabaseUser(saToken, dest.project, INSTANCE_ID, serviceAccountEmail);
  if (!userResult.ok) {
    return { ok: false, error: `Cloud SQL IAM user: ${userResult.error}`, fidelityNotes: [] };
  }

  // The deployed agent authenticates as Google's OWN Reasoning Engine runtime service
  // agent, never as this codebase's provisioning SA — the same identity gap already
  // handled for Discovery Engine grounding (adkDeployer.ts's
  // ensureReasoningEngineDiscoveryAccess). Best-effort: our SA may lack
  // resourcemanager.projects.setIamPolicy on the customer's project, in which case this
  // surfaces as a needs-review fidelity note rather than failing the whole migration —
  // rows are still copied and queryable by hand even if the live tool can't reach them yet.
  let readerIamUsers: string[] = [];
  let reasoningEngineAccessNote: FidelityNote | undefined;
  const projectNumber = await resolveProjectNumber(dest.project, saToken);
  if (!projectNumber) {
    reasoningEngineAccessNote = {
      component: `tool:${toolLabel}`,
      status: 'needs-review',
      detail: `Could not resolve project number for "${dest.project}" — skipped granting the deployed agent's runtime identity access to this Cloud SQL table. The live tool will likely fail with an authorization error until this is granted manually.`,
    };
    logger.warn({ project: dest.project, entityName }, 'cloudSqlMigration: could not resolve project number — skipped Reasoning Engine Cloud SQL grant');
  } else {
    const reasoningEngineSaEmail = `service-${projectNumber}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`;
    const iamGrant = await ensureReasoningEngineCloudSqlAccess(dest.project, projectNumber, saToken);
    const dbUser = await ensureIamDatabaseUser(saToken, dest.project, INSTANCE_ID, reasoningEngineSaEmail, false);
    logger.info(
      { project: dest.project, entityName, reasoningEngineSaEmail, iamGrantOk: iamGrant.ok, iamGrantAlreadyGranted: iamGrant.alreadyGranted, dbUserOk: dbUser.ok },
      'cloudSqlMigration: Reasoning Engine Cloud SQL access grant result',
    );
    if (!iamGrant.ok || !dbUser.ok) {
      reasoningEngineAccessNote = {
        component: `tool:${toolLabel}`,
        status: 'needs-review',
        detail: `Could not fully grant the deployed agent's runtime identity (${reasoningEngineSaEmail}) access to this Cloud SQL table (${[iamGrant.error, dbUser.error].filter(Boolean).join('; ')}) — the live tool may fail with an authorization error until this is granted manually.`,
      };
    } else {
      readerIamUsers = [reasoningEngineSaEmail.replace(/\.gserviceaccount\.com$/, '')];
    }
  }

  const iamUser = serviceAccountEmail.replace(/\.gserviceaccount\.com$/, '');
  const instanceConnectionName = `${dest.project}:us-central1:${INSTANCE_ID}`;
  const write = await ensureTableAndUpsertRows(instanceConnectionName, database, iamUser, entityName, columns, rows, readerIamUsers);
  if (!write.ok) {
    return { ok: false, error: `writing rows to Cloud SQL: ${write.error}`, fidelityNotes: [] };
  }

  logger.info(
    { entityName, database, rowsWritten: write.rowsWritten },
    'cloudSqlMigration: Dataverse table copied to Cloud SQL',
  );

  const fidelityNotes: FidelityNote[] = [
    {
      component: `tool:${toolLabel}`,
      status: 'needs-review',
      detail:
        `Copied ${write.rowsWritten} row(s) from Dataverse table "${entityName}" into Cloud SQL ("Use Cloud SQL" chosen). ` +
        `Dataverse's own row-level security (Business Unit/ownership — the reason this tool ran as "invoker") has NO ` +
        `equivalent in this Cloud SQL table: every caller now sees the same rows, not a per-user-scoped view. ` +
        `This copy is point-in-time as of this migration run — rows changed in Dataverse after this run are not reflected.`,
    },
    {
      component: `tool:${toolLabel}`,
      status: 'partial',
      detail: `This tool is read-only against Cloud SQL in this version — the source's plausible ability to write updates back is not yet reproduced.`,
    },
  ];
  if (flattenedNotes.length) {
    fidelityNotes.push({
      component: `tool:${toolLabel}`,
      status: 'partial',
      detail: `Column shape changes on copy: ${flattenedNotes.join(' ')}`,
    });
  }
  if (reasoningEngineAccessNote) {
    fidelityNotes.push(reasoningEngineAccessNote);
  }

  return {
    ok: true,
    cloudSqlTarget: {
      instanceConnectionName,
      database,
      table: entityName,
      primaryKeyAttr: pk,
      columns: columns.map((c) => c.name),
    },
    fidelityNotes,
  };
}
