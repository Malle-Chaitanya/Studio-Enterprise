/** Reset the built-in postgres superuser's password (Cloud SQL API), so we can connect
 *  once as admin and grant our IAM user CREATE on schema public.
 *  npx tsx src/spikes/_diag_reset_postgres_pw_and_grant.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { randomBytes } from 'node:crypto';

const PROJECT = 'agentmigrations';
const INSTANCE = 'csge-feasibility-test';
const saToken = await getSaToken();
const headers = { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': PROJECT, 'Content-Type': 'application/json' };

const pw = randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '') + 'Aa1!';
const res = await fetch(
  `https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${INSTANCE}/users?host=&name=postgres`,
  { method: 'PUT', headers, body: JSON.stringify({ password: pw }) },
);
console.log('status:', res.status);
console.log(JSON.stringify(await res.json(), null, 2).slice(0, 500));
console.log('\nPOSTGRES_TEST_PW=' + pw);
process.exit(0);
