/** Final pre-demo sanity check: confirm the identity override fix is still in place,
 *  and confirm the license/engine-role state for erik/alex/ben on Migrationn.com is
 *  actually ready (not just the override mapping, but real destination-side access).
 *   npx tsx src/spikes/_diag_final_precheck.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';

const PROJECT = '505103737920';

async function main() {
  await connectMongo();
  const coll = getDb().collection('identityMappings');
  const doc = await coll.findOne({ tenantId: '807d6772-847c-40e2-9bec-e2c930b3a42e', appUserId: '6a5dfdff7cf05623332758b7' });
  console.log('--- 1. Override mapping (should be email-keyed) ---');
  console.log(JSON.stringify((doc as any)?.users, null, 2));

  const token = await getSaToken('admin@migrationn.com');
  console.log('\n--- 2. Current licenses in this project ---');
  const licRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/userStores/default_user_store/userLicenses?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
  const licBody = await licRes.json() as { userLicenses?: { userPrincipal?: string; licenseAssignmentState?: string }[] };
  for (const l of licBody.userLicenses ?? []) console.log(` ${l.userPrincipal}: ${l.licenseAssignmentState}`);

  console.log('\n--- 3. Project-level agentspaceUser (engine role) ---');
  const projRes = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT}:getIamPolicy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const projBody = await projRes.json() as { bindings?: { role: string; members: string[] }[] };
  console.log((projBody.bindings ?? []).find((b) => b.role === 'roles/discoveryengine.agentspaceUser')?.members ?? '(none)');

  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
