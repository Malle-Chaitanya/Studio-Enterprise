import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

async function main() {
  const project = '72860638029';
  const token = await getSaToken('zara@storefuze.com');
  const storeUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/userStores/default_user_store`;
  console.log('--- userStore ---');
  const storeRes = await fetch(storeUrl, { headers: { Authorization: `Bearer ${token}` } });
  console.log(storeRes.status, (await storeRes.text()).slice(0, 500));

  console.log('\n--- userLicenses ---');
  const licRes = await fetch(`${storeUrl}/userLicenses?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(licRes.status, (await licRes.text()));

  console.log('\n--- engines in project 72860638029 ---');
  const eRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/engines`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(eRes.status, (await eRes.text()).slice(0, 600));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
