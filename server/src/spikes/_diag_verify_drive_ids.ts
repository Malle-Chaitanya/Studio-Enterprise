import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const DATA_STORE_ID = 'erik-googledrive_1786356561493_google_drive';

async function main() {
  const saToken = await getSaToken();
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores/${DATA_STORE_ID}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log('status:', res.status);
  console.log(await res.text());
}
main().catch((e) => console.error('FAILED:', e.message));
