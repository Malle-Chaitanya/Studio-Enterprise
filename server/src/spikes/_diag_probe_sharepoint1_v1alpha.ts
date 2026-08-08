import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'sharepoint1_1785966276565_file';
const servingConfig = `projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/servingConfigs/default_config`;

async function search(saToken: string, version: string, query: string) {
  const res = await fetch(`https://discoveryengine.googleapis.com/${version}/${servingConfig}:search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, contentSearchSpec: { searchResultMode: 'DOCUMENTS' } }),
  });
  console.log(`\n>>> ${version} query: "${query}"`);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 1500));
}
async function main() {
  const saToken = await getSaToken();
  await search(saToken, 'v1alpha', 'daily');
  await search(saToken, 'v1', 'daily');
}
main().catch((e) => console.error('FAILED:', e.message));
