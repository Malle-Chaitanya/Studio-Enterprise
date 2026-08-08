import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = '124794af-3b8f-f111-b8da-0022480b1f83-file-slack-to-teams-migrat';
const servingConfig = `projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/servingConfigs/default_config`;

async function main() {
  const saToken = await getSaToken();
  const res = await fetch('https://discoveryengine.googleapis.com/v1beta/' + servingConfig + ':search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '', contentSearchSpec: { searchResultMode: 'DOCUMENTS' } }),
  });
  const json = JSON.parse(await res.text());
  console.log('totalSize:', json.totalSize);
  console.log('document:', JSON.stringify(json.results?.[0]?.document, null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
