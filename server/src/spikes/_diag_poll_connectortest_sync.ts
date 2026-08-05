// Polls the ConnectorTest sync run until it's no longer RUNNING, then checks
// real content — emits one line per check so Monitor can stream progress.
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const COLLECTION_ID = 'connectortest_1785961359928';
const DATA_STORE_ID = 'connectortest_1785961359928_file';

async function getRunState() {
  const saToken = await getSaToken();
  const res = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/${COLLECTION_ID}/dataConnector/connectorRuns`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  const json: any = await res.json();
  return json.connectorRuns?.[0]; // most recent
}

async function searchNow() {
  const saToken = await getSaToken();
  const servingConfig = `projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}/servingConfigs/default_config`;
  const res = await fetch('https://discoveryengine.googleapis.com/v1beta/' + servingConfig + ':search', {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'daily', contentSearchSpec: { searchResultMode: 'DOCUMENTS' } }),
  });
  return await res.text();
}

async function main() {
  for (let i = 0; i < 40; i++) {
    const run = await getRunState();
    const state = run?.state;
    const fileState = run?.entityRuns?.find((e: any) => e.entityName === 'file');
    console.log(`[poll ${i}] run state=${state} file entity state=${fileState?.state} indexed=${fileState?.indexedRecordCount} errors=${JSON.stringify(fileState?.errors ?? [])}`);
    if (state && state !== 'RUNNING') {
      console.log('SYNC_FINISHED state=' + state);
      const searchResult = await searchNow();
      console.log('SEARCH_RESULT: ' + searchResult.slice(0, 1500));
      return;
    }
    await new Promise((r) => setTimeout(r, 15000));
  }
  console.log('TIMED_OUT still running after polling window');
}
main().catch((e) => console.error('FAILED:', e.message));
