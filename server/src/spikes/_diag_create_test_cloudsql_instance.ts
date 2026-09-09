/** Create a small, cheap test Cloud SQL for PostgreSQL instance in agentmigrations, with
 *  IAM database authentication enabled, to verify the architect design's second blocking
 *  assumption: can the deployed agent connect without a stored password. Cheapest tier
 *  (db-f1-micro) -- intended to be deleted after the test.
 *  npx tsx src/spikes/_diag_create_test_cloudsql_instance.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const PROJECT = 'agentmigrations';
const INSTANCE = 'csge-feasibility-test';
const REGION = 'us-central1';
const headers = { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': PROJECT, 'Content-Type': 'application/json' };

const body = {
  name: INSTANCE,
  databaseVersion: 'POSTGRES_15',
  region: REGION,
  settings: {
    tier: 'db-f1-micro',
    ipConfiguration: { ipv4Enabled: true },
    databaseFlags: [{ name: 'cloudsql.iam_authentication', value: 'on' }],
  },
};

const res = await fetch(`https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances`, {
  method: 'POST',
  headers,
  body: JSON.stringify(body),
});
console.log('create status:', res.status);
const json = await res.json();
console.log(JSON.stringify(json, null, 2).slice(0, 1500));
process.exit(0);
