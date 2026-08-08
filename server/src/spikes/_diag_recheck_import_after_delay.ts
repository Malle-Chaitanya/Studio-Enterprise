import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

async function main() {
  const project = '231705905417';
  const dataStoreId = 'ee2ea155-208c-f111-ab0f-0022480a981d-file-daily-queri-rmshbdqsk';
  const saToken = await getSaToken();
  const res = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/dataStores/${dataStoreId}/servingConfigs/default_config:search`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '', contentSearchSpec: { searchResultMode: 'DOCUMENTS' } }),
    },
  );
  console.log('status:', res.status);
  console.log(await res.text());
}
main().catch((e) => console.error('FAILED:', e.message));
