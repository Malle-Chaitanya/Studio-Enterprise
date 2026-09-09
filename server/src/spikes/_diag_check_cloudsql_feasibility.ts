/** Cheap, non-destructive pre-flight for the Dataverse->CloudSQL design: is the Cloud SQL
 *  Admin API enabled on the customer project, and does our existing SA already have any
 *  relevant IAM role? Creates/costs nothing. npx tsx src/spikes/_diag_check_cloudsql_feasibility.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const PROJECT = 'agentmigrations';

console.log('=== Is sqladmin.googleapis.com enabled? ===');
const svcRes = await fetch(
  `https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/sqladmin.googleapis.com`,
  { headers: { Authorization: `Bearer ${saToken}` } },
);
console.log('status:', svcRes.status);
console.log((await svcRes.text()).slice(0, 500));

console.log('\n=== Current IAM policy on the project (looking for our SA + cloudsql roles) ===');
const iamRes = await fetch(
  `https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`,
  { method: 'POST', headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' }, body: '{}' },
);
const iamJson = (await iamRes.json()) as { bindings?: { role: string; members: string[] }[] };
const relevant = (iamJson.bindings ?? []).filter((b) => b.role.toLowerCase().includes('sql') || b.members.some((m) => m.includes('aiplatform') || m.includes('reasoning')));
console.log('status:', iamRes.status);
console.log(JSON.stringify(relevant, null, 2));

console.log('\n=== Existing Cloud SQL instances on this project (if any) ===');
const instRes = await fetch(
  `https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances`,
  { headers: { Authorization: `Bearer ${saToken}` } },
);
console.log('status:', instRes.status);
console.log((await instRes.text()).slice(0, 1000));
process.exit(0);
