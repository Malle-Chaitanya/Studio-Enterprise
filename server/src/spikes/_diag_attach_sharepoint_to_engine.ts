// Verifies the fix: attach the SharePoint connector's data store to the real
// destination engine RIGHT NOW (idempotent, zero agent-creation quota cost),
// then read the Engine resource back to confirm it's actually listed under
// Engine.dataStoreIds — i.e. genuinely "inside the app-connected data store,"
// not sitting outside it, which is what the user found in Console.
//   npx tsx src/spikes/_diag_attach_sharepoint_to_engine.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { attachDataStoreToEngine } from '../services/geminiDataStore.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'sp-filefuze-cddd60ea5b99_file';

async function main() {
  const saToken = await getSaToken();
  const dest = await resolveDestination(PROJECT, saToken);
  console.log(`project: ${dest.project}\nengine: ${dest.engine}\ndataStoreId: ${DATA_STORE_ID}\n`);

  console.log('attaching...');
  const result = await attachDataStoreToEngine(dest, saToken, DATA_STORE_ID);
  console.log(JSON.stringify(result, null, 2));

  const engineUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}`;
  const res = await fetch(engineUrl, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = (await res.json()) as { dataStoreIds?: string[] };
  console.log('\nEngine.dataStoreIds now:', json.dataStoreIds);
  console.log('includes our SharePoint store:', !!json.dataStoreIds?.includes(DATA_STORE_ID));
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
