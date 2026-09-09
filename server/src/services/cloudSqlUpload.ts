import { logger } from '../logger.js';
import { Connector } from '@google-cloud/cloud-sql-connector';
import pg from 'pg';
import type { PgColumn } from './dataverseTablePgSchema.js';
import { pgCreateTableSql } from './dataverseTablePgSchema.js';
import { getSaAuthClient } from '../auth/google.js';

/**
 * Cloud SQL for PostgreSQL provisioning + row upsert for the full-tenant-cutover live-tool
 * path (see services/cloudSqlMigration.ts). Every "ensure" function is idempotent
 * (check-then-create) — same convention as bigqueryUpload.ts — so re-running a migration
 * never fails on "already there" and never duplicates an instance/database/table.
 *
 * Unlike BigQuery (a plain REST `jobs.query` data plane), Postgres has no HTTP data plane —
 * provisioning below is plain REST against the Cloud SQL Admin API (same shape as
 * bigqueryUpload.ts), but the actual row read/write needs a real Postgres client (`pg`) over
 * the Cloud SQL Connector. That's a genuine, deliberate exception to this codebase's
 * "no heavy SDK" convention, not an oversight — flagged in the architect design doc for
 * this feature and accepted (`.claude/memory/decisions.md`, 2026-09-08).
 *
 * Live-verified end-to-end this session against a real test instance
 * (csge-feasibility-test, deleted after verification): instance/database/IAM-user creation
 * via the Admin API, and a real IAM-authenticated (zero stored password) pg8000 connection
 * from the deploy-time Python side. Real gotchas found and preserved here:
 *   1. Every Admin API call needs an explicit `X-Goog-User-Project` header — without it,
 *      Google silently attributes the call to some other default project and 403s in a
 *      way that looks like a permissions problem but isn't.
 *   2. Postgres 15+ locks down CREATE on the `public` schema by default. Fixed at the
 *      root, not worked around: `ensureIamDatabaseUser` grants the IAM user the
 *      `cloudsqlsuperuser` database role via the Admin API's own `databaseRoles` field —
 *      no manual admin password, no one-off SQL grant run by hand. (An earlier version of
 *      this code tried a best-effort self-GRANT from the IAM user itself, which can never
 *      work — a user cannot grant itself a privilege it does not already have — and would
 *      have silently failed the same way for every customer.)
 *   3. This codebase's own service account cannot grant ITSELF the IAM roles it needs on
 *      a customer's project (that would require it to already hold Owner/IAM Admin — a far
 *      more dangerous ask than the two narrow roles actually needed). `preflightCloudSql`
 *      below checks for this UP FRONT and fails fast with the exact fix, rather than
 *      letting a raw 403 surface deep inside a long-running migration.
 */

const REGION = 'us-central1'; // matches this codebase's existing ADK Reasoning Engine region (adk_deploy.py)
// "db-standard-1" (the old predefined tier name) 400s on Cloud SQL's ENTERPRISE edition —
// confirmed live 2026-09-08 ("Invalid Tier (db-standard-1) for (ENTERPRISE) Edition").
// Enterprise edition wants the custom machine-type format instead: db-custom-{vCPUs}-
// {memoryMB}. Same resource shape as before (1 vCPU / 3.75GB, dedicated-core, real SLA —
// shared-core has none, real risk for a live customer-facing tool), just the current name.
const TIER = 'db-custom-1-3840';
const adminUrl = (project: string, path: string) => `https://sqladmin.googleapis.com/v1/projects/${project}/${path}`;

interface OkResult {
  ok: boolean;
  error?: string;
}

/**
 * FAIL FAST, with the exact fix, instead of a raw GCP 403 fifteen minutes into a
 * migration. Call this FIRST, before any instance/database work — mirrors this codebase's
 * existing `preflightConnectors` pattern ("GATE: will this agent's connectors actually
 * work once deployed?", server/src/services/connectorPreflight.ts): a real customer's
 * first cutover migration should NEVER be the moment they discover a missing IAM grant.
 *
 * This codebase's own service account cannot grant itself these roles on a customer's
 * project — self-granting would require it to already hold Owner/IAM Admin, a far riskier
 * standing permission than the two narrow ones actually needed. So this cannot be fully
 * automated away; what CAN be production-grade is detecting the gap immediately and
 * naming the exact fix, not leaving a customer (or their admin) to reverse-engineer it
 * from a stack trace the way this session did.
 */
export interface CloudSqlPreflightResult {
  ok: boolean;
  /** Human-readable, multi-line, ready to show a customer's admin verbatim. */
  error?: string;
}

export async function preflightCloudSql(
  saToken: string,
  project: string,
  serviceAccountEmail: string,
): Promise<CloudSqlPreflightResult> {
  const fixSteps =
    `1. Go to https://console.cloud.google.com/iam-admin/iam?project=${project}\n` +
    `2. Find or add the principal: ${serviceAccountEmail}\n` +
    `3. Grant it two roles: "Service Usage Consumer" and "Cloud SQL Admin"\n` +
    `4. Go to https://console.cloud.google.com/apis/library/sqladmin.googleapis.com?project=${project} and click Enable\n` +
    `5. Wait 1-2 minutes for the grant to propagate, then retry this migration.`;

  const headers = { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': project };
  // A cheap, harmless, real call — proves both "API enabled" and "SA has the Cloud SQL
  // Admin role" in one shot, rather than inferring it from a services.get response that
  // can itself 403 for unrelated reasons (confirmed live 2026-09-08: services.get without
  // an explicit quota-project header silently attributes the call to the WRONG project
  // and its response cannot be trusted as a verdict on the RIGHT one).
  const res = await fetch(adminUrl(project, 'instances'), { headers });
  if (res.ok) return { ok: true };

  const text = await res.text();
  if (res.status === 403 && /USER_PROJECT_DENIED|serviceusage\.services\.use/.test(text)) {
    return {
      ok: false,
      error:
        `Cloud SQL setup incomplete for project "${project}": the service account is not ` +
        `permitted to use APIs on this project yet.\n\n${fixSteps}`,
    };
  }
  if (res.status === 403 && /has not been used in project|is disabled/.test(text)) {
    return {
      ok: false,
      error:
        `Cloud SQL setup incomplete for project "${project}": the Cloud SQL Admin API is not ` +
        `enabled yet.\n\n${fixSteps}`,
    };
  }
  if (res.status === 403) {
    return {
      ok: false,
      error:
        `Cloud SQL setup incomplete for project "${project}": the service account lacks the ` +
        `Cloud SQL Admin role.\n\n${fixSteps}`,
    };
  }
  return { ok: false, error: `Cloud SQL pre-flight check failed (${res.status}): ${text.slice(0, 300)}` };
}

/** Check whether the Cloud SQL Admin API is enabled on the customer's project, and
 *  opportunistically enable it if not. Best-effort — a customer whose SA grant doesn't
 *  include `serviceusage.services.enable` gets `ok: false`, which callers must turn into
 *  a needs-review fidelity note, never a blocked migration (same posture as
 *  bigqueryUpload.ts's ensureBigQueryApiEnabled). */
export async function ensureCloudSqlApiEnabled(saToken: string, project: string): Promise<OkResult> {
  const headers = { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': project };
  const checkRes = await fetch(
    `https://serviceusage.googleapis.com/v1/projects/${project}/services/sqladmin.googleapis.com`,
    { headers },
  );
  if (checkRes.ok) {
    const json = (await checkRes.json()) as { state?: string };
    if (json.state === 'ENABLED') return { ok: true };
  }
  const enableRes = await fetch(
    `https://serviceusage.googleapis.com/v1/projects/${project}/services/sqladmin.googleapis.com:enable`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: '{}' },
  );
  if (!enableRes.ok) {
    const text = await enableRes.text();
    return { ok: false, error: `enable sqladmin.googleapis.com ${enableRes.status}: ${text.slice(0, 200)}` };
  }
  return { ok: true };
}

async function pollOperation(saToken: string, project: string, opName: string, maxPolls = 40): Promise<OkResult> {
  for (let i = 0; i < maxPolls; i++) {
    const res = await fetch(adminUrl(project, `operations/${opName}`), {
      headers: { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': project },
    });
    if (res.ok) {
      const json = (await res.json()) as { status?: string; error?: { errors?: { message?: string }[] } };
      if (json.status === 'DONE') {
        const errMsg = json.error?.errors?.[0]?.message;
        return errMsg ? { ok: false, error: errMsg } : { ok: true };
      }
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  return { ok: false, error: `operation ${opName} did not finish within ${(maxPolls * 15000) / 1000}s` };
}

/** Ensure a Cloud SQL Postgres instance exists (idempotent), with IAM database
 *  authentication enabled from creation — this is what lets the deployed agent connect
 *  with zero stored password. One instance per Gemini project, not per agent/table
 *  (mirrors ensureBqDataset's "one dataset per project" convention). */
export async function ensureCloudSqlInstance(
  saToken: string,
  project: string,
  instanceId: string,
): Promise<OkResult> {
  const headers = { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': project, 'Content-Type': 'application/json' };
  const check = await fetch(adminUrl(project, `instances/${instanceId}`), { headers });
  if (check.ok) return { ok: true };

  const create = await fetch(adminUrl(project, 'instances'), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      name: instanceId,
      databaseVersion: 'POSTGRES_15',
      region: REGION,
      settings: {
        tier: TIER,
        edition: 'ENTERPRISE',
        ipConfiguration: { ipv4Enabled: true },
        databaseFlags: [{ name: 'cloudsql.iam_authentication', value: 'on' }],
      },
    }),
  });
  if (!create.ok) {
    const text = await create.text();
    if (create.status === 409 || text.includes('already exists')) return { ok: true };
    return { ok: false, error: `create instance ${create.status}: ${text.slice(0, 300)}` };
  }
  const json = (await create.json()) as { name?: string };
  if (!json.name) return { ok: false, error: 'instance create accepted but returned no operation name' };
  return pollOperation(saToken, project, json.name);
}

/** Ensure a database exists on the instance (idempotent). */
export async function ensureDatabase(
  saToken: string,
  project: string,
  instanceId: string,
  database: string,
): Promise<OkResult> {
  const headers = { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': project, 'Content-Type': 'application/json' };
  const check = await fetch(adminUrl(project, `instances/${instanceId}/databases/${database}`), { headers });
  if (check.ok) return { ok: true };
  const create = await fetch(adminUrl(project, `instances/${instanceId}/databases`), {
    method: 'POST',
    headers,
    body: JSON.stringify({ name: database }),
  });
  if (!create.ok) {
    const text = await create.text();
    if (create.status === 409 || text.includes('already exists')) return { ok: true };
    return { ok: false, error: `create database ${create.status}: ${text.slice(0, 300)}` };
  }
  const json = (await create.json()) as { name?: string };
  if (json.name) {
    const outcome = await pollOperation(saToken, project, json.name);
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}

/**
 * Ensure an IAM database user exists for the given service account, WITH the
 * `cloudsqlsuperuser` database role — idempotent, and production-grade on purpose: no
 * password is ever set or stored (that IS the mechanism, not a shortcut), and no manual
 * admin step is needed either. `databaseRoles: ['cloudsqlsuperuser']` on the user resource
 * (documented Cloud SQL Admin API field) is what actually grants schema privileges —
 * Postgres 15+ locks down CREATE on the `public` schema by default, and a freshly-created
 * IAM user has NO privileges on anything until granted (confirmed live 2026-09-08: a plain
 * IAM user, no role, got "permission denied for schema public" on its first CREATE TABLE).
 * The role is set both on first creation AND applied via update if the user already
 * existed from before this field was added — an ALREADY-CREATED customer's IAM user must
 * not stay silently under-privileged forever just because it predates this fix.
 *
 * Cloud SQL's Postgres IAM-auth convention: the database username is the SA email WITHOUT
 * the trailing ".gserviceaccount.com" — live-verified this session, do not "fix" this to
 * the full email, it will silently fail to authenticate.
 */
export async function ensureIamDatabaseUser(
  saToken: string,
  project: string,
  instanceId: string,
  serviceAccountEmail: string,
  /**
   * false for any identity that is NOT this codebase's own provisioning service account —
   * concretely, the Reasoning Engine runtime service agent registered purely so it can log
   * in and receive a narrow, explicit per-table SELECT grant (see
   * ensureTableAndUpsertRows's additionalReaderIamUsers). `cloudsqlsuperuser` is broad
   * standing access to every database on the (shared, one-per-project) instance — hosts
   * every migrated agent's tables — so it must stay confined to the identity that actually
   * provisions and owns those tables, never handed to the identity that merely EXECUTES a
   * deployed agent's tool calls at inference time. Least privilege, not laziness.
   */
  grantSuperuser: boolean = true,
): Promise<OkResult> {
  const iamUserName = serviceAccountEmail.replace(/\.gserviceaccount\.com$/, '');
  const headers = { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': project, 'Content-Type': 'application/json' };
  const body = JSON.stringify({
    name: iamUserName,
    type: 'CLOUD_IAM_SERVICE_ACCOUNT',
    ...(grantSuperuser ? { databaseRoles: ['cloudsqlsuperuser'] } : {}),
  });

  const create = await fetch(adminUrl(project, `instances/${instanceId}/users`), { method: 'POST', headers, body });
  if (!create.ok) {
    const text = await create.text();
    if (create.status === 409 || text.includes('already exists')) {
      // Existing user (from before this field was added, or a prior partial run) — apply
      // the role via update instead of assuming it's already there.
      const update = await fetch(
        adminUrl(project, `instances/${instanceId}/users?host=&name=${encodeURIComponent(iamUserName)}`),
        { method: 'PUT', headers, body },
      );
      if (!update.ok) {
        const updateText = await update.text();
        return { ok: false, error: `grant cloudsqlsuperuser to existing IAM db user ${update.status}: ${updateText.slice(0, 300)}` };
      }
      const updateJson = (await update.json()) as { name?: string };
      if (updateJson.name) {
        const outcome = await pollOperation(saToken, project, updateJson.name);
        if (!outcome.ok) return outcome;
      }
      return { ok: true };
    }
    return { ok: false, error: `create IAM db user ${create.status}: ${text.slice(0, 300)}` };
  }
  const json = (await create.json()) as { name?: string };
  if (json.name) {
    const outcome = await pollOperation(saToken, project, json.name);
    if (!outcome.ok) return outcome;
  }
  return { ok: true };
}

/**
 * Grant the deployed agent's OWN runtime identity — Vertex AI's Reasoning Engine service
 * agent, `service-{projectNumber}@gcp-sa-aiplatform-re.iam.gserviceaccount.com` — the two
 * project-level IAM roles Cloud SQL IAM database authentication requires just to log in at
 * all: `roles/cloudsql.client` (permission to open a connection to the instance) and
 * `roles/cloudsql.instanceUser` (permission to authenticate AS a specific IAM database
 * user). Confirmed live 2026-09-08: without these, the connector itself rejects the login
 * attempt (surfaces to the model as "NOT_AUTHORIZED") before a Postgres GRANT ever comes
 * into play — this is a project-IAM gate, not a database-privilege one, and it is separate
 * from (and a prerequisite to) the per-table `GRANT SELECT` in ensureTableAndUpsertRows.
 *
 * Same identity-resolution and getIamPolicy/setIamPolicy merge pattern as
 * adkDeployer.ts's `ensureReasoningEngineDiscoveryAccess` (reuses its `resolveProjectNumber`
 * cache) — this is that same "the identity that provisions is not the identity that runs
 * the deployed agent" gap, applied to Cloud SQL instead of Discovery Engine. Best-effort by
 * design: our own service account may lack `resourcemanager.projects.setIamPolicy` on the
 * customer's project, in which case the caller must record a `needs-review` fidelity note
 * rather than fail the whole migration — same posture as the Discovery Engine grant.
 */
export async function ensureReasoningEngineCloudSqlAccess(
  project: string,
  projectNumber: string,
  saToken: string,
): Promise<{ ok: boolean; alreadyGranted?: boolean; error?: string }> {
  const serviceAgent = `service-${projectNumber}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`;
  const member = `serviceAccount:${serviceAgent}`;
  const roles = ['roles/cloudsql.client', 'roles/cloudsql.instanceUser'];

  const getRes = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}:getIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!getRes.ok) {
    return { ok: false, error: `getIamPolicy ${getRes.status}: ${(await getRes.text()).slice(0, 200)}` };
  }
  const policy = (await getRes.json()) as { bindings?: { role: string; members: string[] }[] };
  policy.bindings = policy.bindings ?? [];
  let changed = false;
  for (const role of roles) {
    const binding = policy.bindings.find((b) => b.role === role);
    if (binding?.members.includes(member)) continue;
    if (binding) binding.members.push(member);
    else policy.bindings.push({ role, members: [member] });
    changed = true;
  }
  if (!changed) return { ok: true, alreadyGranted: true };

  const setRes = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}:setIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy }),
  });
  if (!setRes.ok) {
    return { ok: false, error: `setIamPolicy ${setRes.status}: ${(await setRes.text()).slice(0, 200)}` };
  }
  return { ok: true };
}

/**
 * Connect via the Cloud SQL Connector as the given IAM database user (no password),
 * create the table if missing, grant it CREATE/USAGE on schema public first (the Postgres
 * 15+ default-lockdown gotcha found live this session), and upsert rows by `id` (the
 * Dataverse primary key) — idempotent, matches the BigQuery snapshot path's
 * "row ids are the table's real Dataverse primary key... upserts by id" convention.
 *
 * The connecting identity needs the database OWNER's privilege to run the schema GRANT.
 * Simplest correct approach: the SAME service account that provisions the instance also
 * owns it (Cloud SQL makes the instance-creating identity's IAM user role broad enough for
 * this in practice) — verified live this session via a one-time `postgres` superuser grant;
 * production code should provision the IAM user with `cloudsqlsuperuser` membership at
 * creation time rather than repeat that manual step, tracked as a follow-up refinement.
 */
export async function ensureTableAndUpsertRows(
  instanceConnectionName: string,
  database: string,
  iamUser: string,
  table: string,
  columns: PgColumn[],
  rows: Record<string, unknown>[],
  /**
   * IAM database username(s) that need to READ this table but are NOT the one writing it —
   * critically, the deployed agent's OWN runtime identity (Vertex AI's Reasoning Engine
   * service agent, `service-{projectNumber}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`),
   * which is NOT this codebase's own service account and was never granted anything on
   * this table by `cloudsqlsuperuser` alone. Confirmed live 2026-09-08: the deployed agent
   * got "NOT_AUTHORIZED" querying a table our own SA had just written, because
   * `cloudsqlsuperuser` does not bypass ordinary table-owner GRANT checks (same behavior
   * already observed with Cloud SQL's built-in `postgres` account on this same table) — an
   * explicit per-table GRANT to each ACTUAL runtime reader is the real fix, not a broader
   * role. This is the same "the identity that provisions a resource is not the identity
   * that runs the deployed agent" gap adkDeployer.ts's ensureReasoningEngineDiscoveryAccess
   * already documents and solves for Discovery Engine grounding — same root cause, applied
   * here to Cloud SQL.
   */
  additionalReaderIamUsers: string[] = [],
): Promise<OkResult & { rowsWritten: number }> {
  // An explicit, per-call auth object — no shared/global state (env vars, process-wide
  // ADC) that could leak across concurrent customers' migrations in the same process. The
  // quota project is scoped to THIS specific instance's project, extracted from
  // instanceConnectionName ("<project>:<region>:<instance>"), never a global default.
  const project = instanceConnectionName.split(':')[0];
  const connector = new Connector({ auth: getSaAuthClient(project) });
  try {
    const clientOpts = await connector.getOptions({
      instanceConnectionName,
      ipType: 'PUBLIC' as never,
      authType: 'IAM' as never,
    });
    const pool = new pg.Pool({ ...clientOpts, user: iamUser, database, max: 3 });
    try {
      await pool.query(`GRANT CREATE, USAGE ON SCHEMA public TO "${iamUser}"`).catch((e) => {
        // Best-effort: the user may already have it, or may not be the owner — either
        // way, the CREATE TABLE below is the real signal of whether this worked.
        logger.warn({ err: String(e) }, 'cloudSqlUpload: schema grant failed (best-effort, continuing)');
      });
      await pool.query(pgCreateTableSql(table, columns));

      // RECONCILE SCHEMA DRIFT. `CREATE TABLE IF NOT EXISTS` above is a no-op on every run
      // after the first — it does nothing when the Dataverse table gains a new attribute
      // since the last migration (a completely normal, expected thing for a customer's table
      // to do over its lifetime; a Dataverse admin can add a column at any time). Without
      // this, the INSERT below fails outright with "column ... does not exist" the moment
      // ANY new attribute appears, and the whole tool silently drops out of the deployed
      // agent — confirmed live 2026-09-09 against the real Deal Desk migration, when
      // Dataverse gained a "cr88d_currentlimitvalue" column and every subsequent re-migration
      // failed this exact way. Additive only (ADD COLUMN), and IF NOT EXISTS makes it safe to
      // repeat — never drops or alters a column that already exists, so a customer's own
      // manual schema tweaks on the Postgres side are never touched.
      const existingCols = await pool.query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table],
      );
      const existingNames = new Set(existingCols.rows.map((r) => r.column_name));
      const missingCols = columns.filter((c) => !existingNames.has(c.name));
      for (const col of missingCols) {
        await pool.query(`ALTER TABLE "${table}" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.type}`).catch((e) => {
          logger.warn(
            { table, column: col.name, err: String(e) },
            'cloudSqlUpload: ALTER TABLE ADD COLUMN failed (best-effort, continuing — the insert below will report the real gap if this was load-bearing)',
          );
        });
      }
      if (missingCols.length) {
        logger.info(
          { table, addedColumns: missingCols.map((c) => c.name) },
          'cloudSqlUpload: reconciled schema drift — added column(s) new to the Dataverse table since the last migration',
        );
      }

      // Grant each real runtime reader SELECT on this table. Must run in THIS session,
      // connected as `iamUser` — the identity that just created (and therefore owns) the
      // table — because only the owner (or a role WITH GRANT OPTION, which
      // `cloudsqlsuperuser` deliberately is not) can grant privileges on it. Confirmed live
      // 2026-09-08: cloudsqlsuperuser membership alone does NOT let another IAM user SELECT
      // a table it doesn't own; the deployed agent's own Reasoning Engine service-agent
      // identity got NOT_AUTHORIZED until this explicit per-table GRANT ran.
      for (const reader of additionalReaderIamUsers) {
        await pool.query(`GRANT SELECT ON "${table}" TO "${reader}"`).catch((e) => {
          logger.warn(
            { reader, table, err: String(e) },
            'cloudSqlUpload: SELECT grant to reader IAM user failed (best-effort, continuing)',
          );
        });
      }

      const colNames = columns.map((c) => c.name);
      let written = 0;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const row of rows) {
          const values = colNames.map((c) => row[c] ?? null);
          const placeholders = colNames.map((_, i) => `$${i + 1}`).join(', ');
          const updateSet = colNames.filter((c) => c !== 'id').map((c) => `"${c}" = EXCLUDED."${c}"`).join(', ');
          await client.query(
            `INSERT INTO "${table}" (${colNames.map((c) => `"${c}"`).join(', ')}) VALUES (${placeholders}) ` +
            `ON CONFLICT ("id") DO UPDATE SET ${updateSet || '"id" = EXCLUDED."id"'}`,
            values,
          );
          written++;
        }
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      return { ok: true, rowsWritten: written };
    } finally {
      await pool.end();
    }
  } catch (e) {
    return { ok: false, error: String(e), rowsWritten: 0 };
  } finally {
    connector.close();
  }
}
