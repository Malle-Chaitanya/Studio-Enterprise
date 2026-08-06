// Full, unfiltered dump of the SharePoint connector's Collection resource,
// plus a search for any dedicated connector-health/run-history endpoint —
// checking for an actual error/health signal instead of assuming "needs
// authorization" without confirming it.
//   npx tsx src/spikes/_diag_full_connector_health.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const COLLECTION_ID = 'sp-filefuze-cddd60ea5b99';

async function get(saToken: string, url: string, label: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log(`\n>>> ${label}`);
  console.log('status:', res.status);
  console.log((await res.text()).slice(0, 4000));
}

async function main() {
  const saToken = await getSaToken();
  const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/${COLLECTION_ID}`;

  await get(saToken, base, 'Collection resource (full)');
  await get(saToken, `${base}/dataConnector`, 'DataConnector resource directly (may 404 if not a real sub-resource)');
  await get(saToken, `${base}/dataConnector/connectorRuns`, 'Connector run history');
  await get(saToken, `${base}/dataConnector/documentProcessingConfig`, 'Document processing config');
  await get(saToken, `${base}:getConnectorSecret`, 'Connector secret/auth status (likely 404, checking anyway)');
}
main().catch((e) => console.error('FAILED:', e.message));
