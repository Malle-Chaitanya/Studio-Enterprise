// Checks whether the SharePoint connector's data store actually has indexed
// documents — an empty store would explain an empty grounded answer
// regardless of any deploy-time wiring fix.
//   npx tsx src/spikes/_diag_check_datastore_content.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'filefuze-sp-d4a33c3a8821_file';

async function main() {
  const saToken = await getSaToken();
  const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}`;

  const dsRes = await fetch(base, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log('data store GET status:', dsRes.status);
  console.log(JSON.stringify(await dsRes.json(), null, 2).slice(0, 1500));

  const docsRes = await fetch(`${base}/branches/default_branch/documents?pageSize=10`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  console.log('\ndocuments LIST status:', docsRes.status);
  const docsJson = await docsRes.json();
  console.log(JSON.stringify(docsJson, null, 2).slice(0, 3000));
}
main().catch((e) => console.error('FAILED:', e.message));
