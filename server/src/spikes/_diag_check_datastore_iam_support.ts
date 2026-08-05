import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = '231705905417';
const DATA_STORE = `projects/${PROJECT}/locations/global/collections/default_collection/dataStores/kb-grounding-verify-test`;
async function main() {
  const token = await getSaToken();
  const res = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${DATA_STORE}:getIamPolicy`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  console.log('status:', res.status);
  console.log(await res.text());
}
main().catch((e) => console.error(e.message));
