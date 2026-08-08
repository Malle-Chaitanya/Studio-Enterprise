import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

async function main() {
  const project = '231705905417';
  const dataStoreId = 'ee2ea155-208c-f111-ab0f-0022480a981d-file-migrate-agent-prd-ful';
  const saToken = await getSaToken();
  const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection`;

  console.log('--- GET existing data store ---');
  const getRes = await fetch(`${base}/dataStores/${dataStoreId}`, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log('GET status:', getRes.status);
  console.log(await getRes.text());

  console.log('--- Re-attempt CREATE (idempotency check, full error) ---');
  const query = `dataStoreId=${encodeURIComponent(dataStoreId)}`;
  const createRes = await fetch(`${base}/dataStores?${query}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Migrate_Agent_PRD_Full (6).pdf (ADK file grounding — probe)',
      industryVertical: 'GENERIC',
      solutionTypes: ['SOLUTION_TYPE_SEARCH'],
      contentConfig: 'CONTENT_REQUIRED',
    }),
  });
  console.log('CREATE status:', createRes.status);
  console.log(await createRes.text());
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
