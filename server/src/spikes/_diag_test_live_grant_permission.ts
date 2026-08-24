/** Tests the REAL ensureAgentAccess call against Nexus Agent right now, to see whether
 *  "0 principals granted" in the latest run is due to (a) unresolved identities (old bug)
 *  or (b) the service account itself lacking permission on this project (matching the
 *  403 "getIamPolicy: caller does not have permission" seen on the grounding IAM grant).
 *   npx tsx src/spikes/_diag_test_live_grant_permission.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { ensureAgentAccess, checkUserLicense, type GeminiDestination } from '../services/gemini.js';

const dest: GeminiDestination = { project: '505103737920', engine: 'gemini-enterprise-app_1787446545912', assistant: 'default_assistant' };
const NEXUS_AGENT_ID = '2261370940660059563';

async function main() {
  const token = await getSaToken('admin@migrationn.com');

  console.log('--- License check for alex@migrationn.com ---');
  const license = await checkUserLicense(dest, token, 'alex@migrationn.com');
  console.log('license:', license);

  console.log('\n--- Live ensureAgentAccess for alex@migrationn.com on Nexus Agent ---');
  const result = await ensureAgentAccess(dest, token, NEXUS_AGENT_ID, { users: ['alex@migrationn.com'], groups: [] }, { appUserId: 'diag-verify-live', tenantId: 'diag' });
  console.log(JSON.stringify(result, null, 2));

  console.log('\n--- Raw project-level getIamPolicy (does the SA even have permission to read/write IAM here?) ---');
  const projRes = await fetch('https://cloudresourcemanager.googleapis.com/v1/projects/505103737920:getIamPolicy', {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  console.log(projRes.status, (await projRes.text()).slice(0, 500));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
