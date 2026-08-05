// The daily_queries.txt data store (filefuze-sp-d4a33c3a8821_file) has no
// knowledgeConnectors DB record — it was provisioned outside this codebase's
// tracked flow. This reads its Collection resource directly by guessing the
// collectionId from the data store's own naming convention ({collectionId}_file).
//   npx tsx src/spikes/_diag_check_daily_queries_collection.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const COLLECTION_ID = 'filefuze-sp-d4a33c3a8821';

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/${COLLECTION_ID}`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  console.log('Collection GET status:', res.status);
  console.log(JSON.stringify(await res.json(), null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
