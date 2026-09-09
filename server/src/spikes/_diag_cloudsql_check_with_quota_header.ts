/** Redo the Cloud SQL Admin API check with an explicit X-Goog-User-Project header, since
 *  the prior call (no header) reported back project 231705905417 ("studio-enterprise-
 *  migration", CloudFuze's OWN platform project) instead of "agentmigrations"
 *  (505103737920, the actual customer/destination project) despite the URL explicitly
 *  saying projects/agentmigrations/... -- likely a quota-project fallback quirk.
 *  npx tsx src/spikes/_diag_cloudsql_check_with_quota_header.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const PROJECT = 'agentmigrations';
const headers = { Authorization: `Bearer ${saToken}`, 'X-Goog-User-Project': PROJECT };

console.log('=== sqladmin.googleapis.com enabled? (with X-Goog-User-Project) ===');
const svcRes = await fetch(
  `https://serviceusage.googleapis.com/v1/projects/${PROJECT}/services/sqladmin.googleapis.com`,
  { headers },
);
console.log('status:', svcRes.status);
console.log((await svcRes.text()).slice(0, 800));

console.log('\n=== list Cloud SQL instances (with X-Goog-User-Project) ===');
const instRes = await fetch(`https://sqladmin.googleapis.com/v1/projects/${PROJECT}/instances`, { headers });
console.log('status:', instRes.status);
console.log((await instRes.text()).slice(0, 800));

console.log('\n=== Who is the SA itself? (tokeninfo) ===');
const tiRes = await fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${saToken}`);
console.log('status:', tiRes.status);
console.log(await tiRes.text());
process.exit(0);
