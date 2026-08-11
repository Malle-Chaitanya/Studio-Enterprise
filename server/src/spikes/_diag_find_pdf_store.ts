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
  const stores = (json.dataStores ?? []).filter((d: any) => d.name.includes('124794af-3b8f-f111-b8da-0022480b1f83'));
  for (const s of stores) console.log(s.name);
}
main().catch((e) => console.error('FAILED:', e.message));
