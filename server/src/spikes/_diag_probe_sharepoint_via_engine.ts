// Alternative hypothesis: federated SharePoint search might only actually
// trigger the live SharePoint fetch when queried through the ENGINE's own
// serving config (which fans out across all attached data stores), not a
// lone SearchService call directly on the data store — unlike regular
// indexed data stores, which are searchable standalone. Test both shapes.
//   npx tsx src/spikes/_diag_probe_sharepoint_via_engine.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'sp-filefuze-cddd60ea5b99_file';

async function search(saToken: string, url: string, body: Record<string, unknown>, label: string) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(`\n>>> ${label}`);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 2500));
}

async function main() {
  const saToken = await getSaToken();
  const dest = await resolveDestination(PROJECT, saToken);

  const engineServingConfig =
    `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection` +
    `/engines/${dest.engine}/servingConfigs/default_search:search`;

  await search(
    saToken,
    engineServingConfig,
    {
      query: 'daily',
      dataStoreSpecs: [{ dataStore: `projects/${dest.project}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}` }],
      contentSearchSpec: { searchResultMode: 'DOCUMENTS' },
    },
    'Engine-level search, scoped to the SharePoint data store',
  );

  await search(
    saToken,
    engineServingConfig,
    { query: 'daily', contentSearchSpec: { searchResultMode: 'DOCUMENTS' } },
    'Engine-level search, UNSCOPED (searches everything attached — includes SharePoint)',
  );
}
main().catch((e) => console.error('FAILED:', e.message));
