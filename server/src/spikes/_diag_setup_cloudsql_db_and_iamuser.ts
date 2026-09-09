/** Create a test database and an IAM database user (SA identity, no password) on the
 *  test Cloud SQL instance. npx tsx src/spikes/_diag_setup_cloudsql_db_and_iamuser.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const INSTANCE = 'csge-feasibility-test';
const saToken = await getSaToken();
const headers = { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': PROJECT, 'Content-Type': 'application/json' };

console.log('=== Create database "csgetest" ===');
const dbRes = await fetch(`https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${INSTANCE}/databases`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: 'csgetest' }),
});
console.log('status:', dbRes.status);
console.log(JSON.stringify(await dbRes.json(), null, 2).slice(0, 500));

console.log('\n=== Create IAM database user for our own SA (no password) ===');
// For Postgres, IAM users are created as type CLOUD_IAM_SERVICE_ACCOUNT, name = SA email
// WITHOUT the trailing ".gserviceaccount.com" per Cloud SQL's Postgres IAM auth convention.
const iamUserName = 'studio-enterprise-migration@studio-enterprise-migration.iam';
const userRes = await fetch(`https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${INSTANCE}/users`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ name: iamUserName, type: 'CLOUD_IAM_SERVICE_ACCOUNT' }),
});
console.log('status:', userRes.status);
console.log(JSON.stringify(await userRes.json(), null, 2).slice(0, 800));
process.exit(0);
