/** Set a temporary postgres password on the REAL csge-dataverse-tables instance, purely
 *  for manual human verification via Cloud SQL Studio -- the deployed agent never uses
 *  this, it authenticates via IAM only. npx tsx src/spikes/_diag_set_real_instance_pw.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { randomBytes } from 'node:crypto';

const PROJECT = 'agentmigrations';
const INSTANCE = 'csge-dataverse-tables';
const saToken = await getSaToken();
const headers = { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': PROJECT, 'Content-Type': 'application/json' };

const pw = randomBytes(18).toString('base64').replace(/[^a-zA-Z0-9]/g, '') + 'Aa1!';
const res = await fetch(
  `https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances/${INSTANCE}/users?host=&name=postgres`,
  { method: 'PUT', headers, body: JSON.stringify({ password: pw }) },
);
console.log('status:', res.status);
console.log('\nPASSWORD=' + pw);
process.exit(0);
