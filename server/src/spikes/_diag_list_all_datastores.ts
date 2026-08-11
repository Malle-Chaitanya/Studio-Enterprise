import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/dataStores?pageSize=200`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  const json: any = await res.json();
  for (const s of json.dataStores ?? []) {
    console.log(s.name.split('/').pop(), '|', s.displayName, '| createTime:', s.createTime);
  }
}
main().catch((e) => console.error('FAILED:', e.message));
