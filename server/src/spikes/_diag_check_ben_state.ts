import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const projectNum = '231705905417';

  console.log('--- 1. All userLicenses right now ---');
  const licRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/studio-enterprise-migration/locations/global/userStores/default_user_store/userLicenses?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
  const licBody = await licRes.json() as { userLicenses?: { userPrincipal?: string; licenseAssignmentState?: string }[] };
  for (const l of licBody.userLicenses ?? []) console.log(` ${l.userPrincipal}: ${l.licenseAssignmentState}`);

  console.log('\n--- 2. Project-level IAM: is ben in roles/discoveryengine.agentspaceUser? ---');
  const projRes = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${projectNum}:getIamPolicy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const projBody = await projRes.json() as { bindings?: { role: string; members: string[] }[] };
  const agentspaceUser = (projBody.bindings ?? []).find((b) => b.role === 'roles/discoveryengine.agentspaceUser');
  console.log('project-level agentspaceUser members:', agentspaceUser?.members ?? []);

  console.log('\n--- 3. Engine-level IAM on geminienterpriseapp_1787403755425 ---');
  const engRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${projectNum}/locations/global/collections/default_collection/engines/geminienterpriseapp_1787403755425:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(await engRes.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
