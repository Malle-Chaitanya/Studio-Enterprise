import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = '231705905417';
const ID = '48248234-cb90-f111-8077-0022480a981d-file-neutara-hr-leave-poli';
async function main() {
  const saToken = await getSaToken();
  const res = await fetch(`https://discoveryengine.googleapis.com/v1beta/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${ID}/servingConfigs/default_config:search`, {
    method: 'POST', headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: '', contentSearchSpec: { searchResultMode: 'DOCUMENTS' } }),
  });
  console.log(await res.text());
}
main().catch((e) => console.error('FAILED:', e.message));
