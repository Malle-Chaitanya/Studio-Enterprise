// Directly probes the SharePoint connector's data store via the Discovery
// Engine SearchService — bypassing the ADK agent entirely — with broad terms
// to check if it returns ANYTHING right now, or is still the same
// never-returned-real-content connector found earlier this session.
//   npx tsx src/spikes/_diag_probe_sharepoint_store_direct.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'sp-filefuze-cddd60ea5b99_file';
const servingConfig = `projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/servingConfigs/default_config`;

async function search(saToken: string, query: string) {
  const res = await fetch('https://discoveryengine.googleapis.com/v1beta/' + servingConfig + ':search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query,
      contentSearchSpec: { searchResultMode: 'DOCUMENTS' },
    }),
  });
  console.log(`\n>>> query: "${query}"`);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 1500));
}

async function main() {
  const saToken = await getSaToken();
  await search(saToken, 'daily'); // broadest possible term — the file's own name
  await search(saToken, 'query');
  await search(saToken, 'report');
  await search(saToken, ''); // empty query — some search backends return "everything" for this
}
main().catch((e) => console.error('FAILED:', e.message));
