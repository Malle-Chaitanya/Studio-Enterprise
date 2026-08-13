/**
 * Ground-truth check: does the Erik_googleDrive data store actually have any
 * indexed/searchable content right now? Bypasses the ADK agent entirely and
 * hits the data store's own search serving config directly.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'erik-googledrive_1786356561493_google_drive';
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection`;

async function search(saToken: string, query: string) {
  const res = await fetch(`${BASE}/dataStores/${DATA_STORE_ID}/servingConfigs/default_config:search`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, contentSearchSpec: { searchResultMode: 'DOCUMENTS' } }),
  });
  console.log(`\n--- query: "${query}" ---`);
  console.log(res.status);
  console.log((await res.text()).slice(0, 3000));
}

async function main() {
  const saToken = await getSaToken();
  await search(saToken, ''); // empty query — should return ~anything if the store has content
  await search(saToken, 'ABCD');
}
main().catch((e) => console.error('FAILED:', e.message));
