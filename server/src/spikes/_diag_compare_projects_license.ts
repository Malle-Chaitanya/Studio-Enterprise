import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

async function check(project: string, label: string) {
  const token = await getSaToken('admin@migrationn.com');
  const storeUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/userStores/default_user_store`;
  console.log(`\n=== ${label} (requested as project=${project}) ===`);
  const storeRes = await fetch(storeUrl, { headers: { Authorization: `Bearer ${token}` } });
  console.log('userStore:', storeRes.status, (await storeRes.text()).slice(0, 400));
  const licRes = await fetch(`${storeUrl}/userLicenses?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
  const body = await licRes.text();
  console.log('userLicenses:', licRes.status, body.slice(0, 1500));

  console.log('--- engines in this project ---');
  const eRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/engines`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(eRes.status, (await eRes.text()).slice(0, 800));
}

async function main() {
  await check('505103737920', 'DESTINATION project (session.geminiProject)');
  await check('studio-enterprise-migration', 'SA HOME project');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
