import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = '48248234-cb90-f111-8077-0022480a981d-file-neutara-hr-leave-poli';
const servingConfig = `projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/servingConfigs/default_config`;

async function search(saToken: string, query: string) {
  const res = await fetch('https://discoveryengine.googleapis.com/v1beta/' + servingConfig + ':search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, contentSearchSpec: { searchResultMode: 'DOCUMENTS' } }),
  });
  console.log(`\n>>> query: "${query}"`);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 2000));
}
async function main() {
  const saToken = await getSaToken();
  await search(saToken, 'vacation');
  await search(saToken, '');
}
main().catch((e) => console.error('FAILED:', e.message));
