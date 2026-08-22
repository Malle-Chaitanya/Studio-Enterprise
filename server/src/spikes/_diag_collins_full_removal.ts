/** Removes Collins's access at BOTH the project and engine level, so the upcoming
 *  migration test starts from a genuine clean slate for him — license intact, IAM
 *  access zero. Records exact before-state first for restoration afterward.
 *   npx tsx src/spikes/_diag_collins_full_removal.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const PROJECT_NUM = '231705905417';
const ENGINE_URL = `https://discoveryengine.googleapis.com/v1alpha/projects/231705905417/locations/global/collections/default_collection/engines/geminienterpriseapp_1787403755425`;
const PRINCIPAL = 'user:collins-gd@storefuze.com';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  console.log('=== PROJECT-LEVEL ===');
  const projGet = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_NUM}:getIamPolicy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: '{}',
  });
  const projBody = await projGet.json() as { bindings: { role: string; members: string[] }[]; etag: string; version?: number };
  const removedProjectRoles = projBody.bindings.filter((b) => b.members.includes(PRINCIPAL)).map((b) => b.role);
  console.log('Removing project roles:', removedProjectRoles);
  const newProjBindings = projBody.bindings
    .map((b) => ({ ...b, members: b.members.filter((m) => m !== PRINCIPAL) }))
    .filter((b) => b.members.length > 0);
  const projSet = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${PROJECT_NUM}:setIamPolicy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy: { bindings: newProjBindings, etag: projBody.etag, version: projBody.version } }),
  });
  console.log('setIamPolicy (project):', projSet.status, (await projSet.text()).slice(0, 200));

  console.log('\n=== ENGINE-LEVEL ===');
  const engGet = await fetch(`${ENGINE_URL}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  const engBody = await engGet.json() as { bindings?: { role: string; members: string[] }[]; etag?: string };
  const removedEngineRoles = (engBody.bindings ?? []).filter((b) => b.members.includes(PRINCIPAL)).map((b) => b.role);
  console.log('Removing engine roles:', removedEngineRoles);
  const newEngBindings = (engBody.bindings ?? []).map((b) => ({ ...b, members: b.members.filter((m) => m !== PRINCIPAL) }));
  const engSet = await fetch(`${ENGINE_URL}:setIamPolicy`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy: { bindings: newEngBindings, etag: engBody.etag } }),
  });
  console.log('setIamPolicy (engine):', engSet.status, (await engSet.text()).slice(0, 200));

  console.log('\n=== RESTORE COMMAND FOR LATER — SAVE THIS ===');
  console.log('Project roles to re-add:', JSON.stringify(removedProjectRoles));
  console.log('Engine roles to re-add:', JSON.stringify(removedEngineRoles));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
