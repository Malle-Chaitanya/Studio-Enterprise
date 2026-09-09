import 'dotenv/config';
import { getSaAuthClient } from '../auth/google.js';
import { Connector } from '@google-cloud/cloud-sql-connector';
import pg from 'pg';

const PROJECT = 'agentmigrations';
const INSTANCE = 'csge-dataverse-tables';
const DATABASE = 'cr88d_clientcreditfacilities';
const TABLE = 'cr88d_clientcreditfacilities';
const IAM_USER = 'studio-enterprise-migration@studio-enterprise-migration.iam';

async function main() {
  const connector = new Connector({ auth: getSaAuthClient(PROJECT) });
  const clientOpts = await connector.getOptions({ instanceConnectionName: `${PROJECT}:us-central1:${INSTANCE}`, ipType: 'PUBLIC' as never, authType: 'IAM' as never });
  const pool = new pg.Pool({ ...clientOpts, user: IAM_USER, database: DATABASE, max: 2 });
  await pool.query(`ALTER TABLE "${TABLE}" ADD COLUMN IF NOT EXISTS "cr88d_currentlimitvalue" BIGINT`);
  console.log('Added cr88d_currentlimitvalue to the live table.');
  await pool.end();
  connector.close();
}
main().catch((e) => { console.error('FAILED:', e.message); if (e.cause) console.error('CAUSE:', e.cause); });
