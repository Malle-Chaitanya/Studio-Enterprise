import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const DS = 'projects/231705905417/locations/global/collections/default_collection/dataStores/124794af-3b8f-f111-b8da-0022480b1f83-file-slack-to-teams-migrat';
async function main() {
  const token = await getSaToken();
  const r = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${DS}`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('datastore status:', r.status);
  console.log((await r.text()).slice(0, 800));
  const docs = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${DS}/branches/default_branch/documents`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('documents status:', docs.status);
  console.log((await docs.text()).slice(0, 1500));
}
main().catch((e) => console.error(e.message));
