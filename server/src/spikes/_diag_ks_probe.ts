/** Search AA's two Dataverse-snapshot stores directly. Read-only. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const P = 'projects/studio-enterprise-migration/locations/global/collections/default_collection/dataStores';
const IDS = [
  'bdf9b817-9b90-f111-b8da-0022480b1f83-tbl-cr88d-cficpprofiles',
  'bdf9b817-9b90-f111-b8da-0022480b1f83-tbl-cr88d-faqentries',
];
const token = await getSaToken();
for (const id of IDS) {
  // How many documents are actually in there?
  const docs = await fetch(`https://discoveryengine.googleapis.com/v1beta/${P}/${id}/branches/default_branch/documents?pageSize=3`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const dbody = await docs.text();
  console.log(`\n=== ${id}`);
  console.log(`documents HTTP ${docs.status}: ${dbody.slice(0, 500)}`);
  for (const mode of ['DOCUMENTS', 'CHUNKS']) {
    const r = await fetch(`https://discoveryengine.googleapis.com/v1beta/${P}/${id}/servingConfigs/default_search:search`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'ICP', pageSize: 3, contentSearchSpec: { searchResultMode: mode } }),
    });
    console.log(`search[${mode}] HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
}
process.exit(0);
