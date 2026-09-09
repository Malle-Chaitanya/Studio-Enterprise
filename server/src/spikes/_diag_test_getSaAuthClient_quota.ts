/** Isolate: does getSaAuthClient('agentmigrations')'s quotaProjectId actually take effect
 *  on a real request, independent of the Cloud SQL Connector entirely?
 *  npx tsx src/spikes/_diag_test_getSaAuthClient_quota.ts */
import 'dotenv/config';
import { getSaAuthClient } from '../auth/google.js';

const auth = getSaAuthClient('agentmigrations');
console.log('projectId (from auth object):', await auth.getProjectId().catch((e) => `ERROR: ${e}`));

const client = await auth.getClient();
console.log('client quotaProjectId:', (client as any).quotaProjectId);

// Real request via GoogleAuth's own .request() — it should attach X-Goog-User-Project
// automatically based on quotaProjectId.
const res = await auth.request({
  url: 'https://sqladmin.googleapis.com/v1/projects/agentmigrations/instances',
});
console.log('status:', res.status);
console.log('data:', JSON.stringify(res.data).slice(0, 300));
process.exit(0);
