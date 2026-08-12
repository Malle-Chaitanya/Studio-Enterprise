import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
// SharePoint's real connector lived at a COLLECTION named after the connector id
// (connectortest_1785961359928), with a nested dataConnector object showing real
// auth/sync state. Checking whether Erik's Drive connector has the same shape,
// under the id WITHOUT the _google_drive suffix (that one 404'd as a data store).
const CANDIDATE_COLLECTION_ID = 'erik-googledrive_1786356561493';

async function main() {
  const saToken = await getSaToken();
  const headers = { Authorization: `Bearer ${saToken}` };

  console.log('--- All collections (looking for the Drive connector) ---');
  const listRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections`,
    { headers },
  );
  const listText = await listRes.text();
  console.log(listRes.status);
  // Print just the parts mentioning google drive / erik, the full list is huge.
  const lines = listText.split(/(?<=,)\s*(?=")/);
  console.log(listText.includes('erik') ? 'contains "erik"' : 'no "erik" match in list');
  console.log(listText.includes('google_drive') || listText.includes('googledrive') ? 'contains a google drive reference' : 'no google drive reference found');

  console.log(`\n--- Direct GET on collection '${CANDIDATE_COLLECTION_ID}' ---`);
  const collRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/${CANDIDATE_COLLECTION_ID}`,
    { headers },
  );
  console.log(collRes.status);
  console.log((await collRes.text()).slice(0, 3000));

  console.log(`\n--- dataConnector under that collection ---`);
  const connRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/${CANDIDATE_COLLECTION_ID}/dataConnector`,
    { headers },
  );
  console.log(connRes.status);
  console.log((await connRes.text()).slice(0, 3000));
}
main().catch((e) => console.error('FAILED:', e.message));
