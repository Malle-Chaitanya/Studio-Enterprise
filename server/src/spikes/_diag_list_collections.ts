// Lists every Collection (connector-level resource) in the project, to find
// the newly-created "sharepointconnector" and inspect its real resource ID
// and DataConnector state while it's still provisioning.
//   npx tsx src/spikes/_diag_list_collections.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';

async function main() {
  const saToken = await getSaToken();
  const res = await fetch(
    `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections`,
    { headers: { Authorization: `Bearer ${saToken}` } },
  );
  const json = await res.json();
  console.log('status:', res.status);
  console.log(JSON.stringify(json, null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
