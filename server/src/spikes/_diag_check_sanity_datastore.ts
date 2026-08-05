// Checks whether the sanity-check file actually landed in its document data
// store, independent of the (possibly premature) import-reconciliation
// result reported by migrateFileToDocumentStore.
//   npx tsx src/spikes/_diag_check_sanity_datastore.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'adk-file-grounding-sanity-check-file-sanity-check-facts-txt';

async function main() {
  const saToken = await getSaToken();
  const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}`;
  const res = await fetch(`${base}/branches/default_branch/documents?pageSize=10`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  console.log('documents LIST status:', res.status);
  console.log(JSON.stringify(await res.json(), null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
