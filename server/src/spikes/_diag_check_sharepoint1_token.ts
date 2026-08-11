import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const COLLECTION_ID = 'sharepoint1_1785966276565';

async function main() {
  const saToken = await getSaToken();
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/${COLLECTION_ID}/dataConnector:checkRefreshToken`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log('status:', res.status);
  console.log(await res.text());
}
main().catch((e) => console.error('FAILED:', e.message));
