import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'ee2ea155-208c-f111-ab0f-0022480a981d-file-daily-queries-txt';

async function main() {
  const saToken = await getSaToken();

  // Check current existence/state
  const getRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  console.log('GET status:', getRes.status);
  console.log(await getRes.text());

  // Try creating it fresh, to see the EXACT real error
  const createRes = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores?dataStoreId=${DATA_STORE_ID}`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        displayName: 'daily_queries.txt (ADK file grounding — ee2ea155-208c-f111-ab0f-0022480a981d)',
        industryVertical: 'GENERIC',
        solutionTypes: ['SOLUTION_TYPE_SEARCH'],
        contentConfig: 'CONTENT_REQUIRED',
      }),
    },
  );
  console.log('\nCREATE status:', createRes.status);
  console.log(await createRes.text());
}
main().catch((e) => console.error('FAILED:', e.message));
