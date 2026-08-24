import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '505103737920';

async function main() {
  const token = await getSaToken('admin@migrationn.com');
  const r = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/licenseConfigs`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await r.text();
  console.log('status', r.status);
  console.log(body);

  console.log('\n--- userStore (to see which licenseConfig it references, if any) ---');
  const usRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/userStores/default_user_store`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(usRes.status, await usRes.text());

  console.log('\n--- engine full dump (uncut) ---');
  const eRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/gemini-enterprise-app_1787446545912`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log(eRes.status, await eRes.text());

  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
