import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const COLLECTION_ID = 'connectortest_1785961359928';
const RUN_ID = process.argv[2];

async function main() {
  const saToken = await getSaToken();
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/${COLLECTION_ID}/dataConnector/connectorRuns/${RUN_ID}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log('status:', res.status);
  console.log(await res.text());
}
main().catch((e) => console.error('FAILED:', e.message));
