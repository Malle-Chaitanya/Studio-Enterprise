import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const COLLECTION_ID = 'connectortest_1785961359928';

async function get(saToken: string, url: string, label: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log(`\n>>> ${label}`);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 4000));
}

async function main() {
  const saToken = await getSaToken();
  const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/${COLLECTION_ID}`;
  await get(saToken, `${base}/dataConnector/connectorRuns`, 'Connector run history');
  await get(saToken, `${base}/dataConnector/connectorRuns?pageSize=10`, 'Connector run history (explicit page size)');
}
main().catch((e) => console.error('FAILED:', e.message));
