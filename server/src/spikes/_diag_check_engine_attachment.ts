import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const PROJECT = '231705905417';

async function main() {
  const saToken = await getSaToken();
  const dest = await resolveDestination(PROJECT, saToken);
  const engineUrl = `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}`;
  const res = await fetch(engineUrl, { headers: { Authorization: `Bearer ${saToken}` } });
  const json: any = await res.json();
  console.log('Engine.dataStoreIds (attached / "inside the app"):');
  console.log(JSON.stringify(json.dataStoreIds, null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
