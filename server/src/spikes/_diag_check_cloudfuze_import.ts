import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'ee2ea155-208c-f111-ab0f-0022480a981d-file-daily-queries-txt';
const servingConfig = `projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/servingConfigs/default_config`;

async function main() {
  const saToken = await getSaToken();
  const res = await fetch('https://discoveryengine.googleapis.com/v1beta/' + servingConfig + ':search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'daily', contentSearchSpec: { searchResultMode: 'DOCUMENTS' } }),
  });
  console.log('status:', res.status);
  console.log(await res.text());
}
main().catch((e) => console.error('FAILED:', e.message));
