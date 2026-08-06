// Triggers an immediate re-sync of ConnectorTest now that GroupMember.Read.All
// has been granted — using the real, confirmed StartConnectorRun REST method
// instead of waiting for its next scheduled run.
//   npx tsx src/spikes/_diag_trigger_connectortest_resync.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const COLLECTION_ID = 'connectortest_1785961359928';

async function main() {
  const saToken = await getSaToken();
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/${COLLECTION_ID}/dataConnector:startConnectorRun`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ entities: ['file'], syncIdentity: true, forceRefreshContent: true }),
  });
  console.log('status:', res.status);
  console.log(await res.text());
}
main().catch((e) => console.error('FAILED:', e.message));
