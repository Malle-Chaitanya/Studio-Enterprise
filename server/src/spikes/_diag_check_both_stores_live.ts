import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

async function check(project: string, dataStoreId: string, label: string) {
  const saToken = await getSaToken();
  const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection`;
  const res = await fetch(`${base}/dataStores/${dataStoreId}`, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log(`${label} (${dataStoreId}) -> GET status ${res.status}`);
  if (res.status !== 200) console.log('  ', (await res.text()).replace(/\s+/g, ' ').slice(0, 200));
}

async function main() {
  await check('231705905417', 'ee2ea155-208c-f111-ab0f-0022480a981d-file-migrate-agent-prd-ful', 'CloudFuze Studio Migrate PDF store');
  await check('231705905417', '48248234-cb90-f111-8077-0022480a981d-file-neutara-hr-leave-poli', 'Employee Onboarding Helper PDF store');
}
main().catch((e) => console.error('FAILED:', e.message));
