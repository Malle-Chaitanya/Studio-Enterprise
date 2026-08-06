// The "sharepointconnector" (Aug 6) and "filefuze-testingpermissions-test"
// (Aug 3) connectors are dataSource:"sharepoint" with auth_type:"OAUTH" —
// a DIFFERENT, richer connector type than "sharepoint_federated_search"
// (which is all we've tested so far). filefuze-testingpermissions-test has
// been ACTIVE for 3 days already — check if IT actually has real content,
// since it went through a real OAuth connector type from the start.
//   npx tsx src/spikes/_diag_probe_oauth_sharepoint.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'filefuze-testingpermissions-test_1785742170965_file';
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
  await search(saToken, 'daily');
  await search(saToken, '');
}
main().catch((e) => console.error('FAILED:', e.message));
