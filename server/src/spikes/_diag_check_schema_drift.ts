import 'dotenv/config';
import { getSaAuthClient } from '../auth/google.js';
import { Connector } from '@google-cloud/cloud-sql-connector';
import pg from 'pg';
import { resolvePrimaryKey } from '../services/dataverseTableExport.js';
import { resolveTableAttributes } from '../services/dataverseTableSchema.js';
import { buildPgSchema } from '../services/dataverseTablePgSchema.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { connectMongo } from '../db/mongo.js';
import { getSession } from '../sessionStore.js';

const PROJECT = 'agentmigrations';
const INSTANCE = 'csge-dataverse-tables';
const DATABASE = 'cr88d_clientcreditfacilities';
const TABLE = 'cr88d_clientcreditfacilities';
const IAM_USER = 'studio-enterprise-migration@studio-enterprise-migration.iam';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const SESSION_ID = 'HcdJ_NRDaodSY7R3q3GFHUaL-0o';

async function main() {
  await connectMongo();
  const session = await getSession(SESSION_ID);
  if (!session?.tenantId) throw new Error('NO_TENANT_ID_ON_SESSION');

  // 1. What columns does the EXISTING live Postgres table actually have?
  const connector = new Connector({ auth: getSaAuthClient(PROJECT) });
  const clientOpts = await connector.getOptions({ instanceConnectionName: `${PROJECT}:us-central1:${INSTANCE}`, ipType: 'PUBLIC' as never, authType: 'IAM' as never });
  const pool = new pg.Pool({ ...clientOpts, user: IAM_USER, database: DATABASE, max: 2 });
  const existing = await pool.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name = $1 ORDER BY ordinal_position`,
    [TABLE],
  );
  console.log(`Existing Postgres table has ${existing.rows.length} column(s):`);
  console.log(existing.rows.map((r) => r.column_name).join(', '));
  await pool.end();
  connector.close();

  // 2. What does the CURRENT Dataverse schema resolve to?
  const dvToken = await clientCredsToken(session.tenantId!, ENV_URL);
  const pk = await resolvePrimaryKey(ENV_URL, dvToken, TABLE);
  const attrs = await resolveTableAttributes(ENV_URL, dvToken, TABLE);
  if (!pk || !attrs) throw new Error('could not resolve current Dataverse schema');
  const { columns } = buildPgSchema(attrs, pk);
  console.log(`\nCurrent Dataverse schema resolves to ${columns.length} column(s):`);
  console.log(columns.map((c) => c.name).join(', '));

  const existingNames = new Set(existing.rows.map((r) => r.column_name));
  const missing = columns.filter((c) => !existingNames.has(c.name));
  console.log(`\n${missing.length} column(s) in the current schema MISSING from the existing table:`);
  console.log(missing.map((c) => `${c.name} (${c.type})`).join(', ') || '(none)');
}
main().catch((e) => { console.error('FAILED:', e.message); if (e.cause) console.error('CAUSE:', e.cause); });
