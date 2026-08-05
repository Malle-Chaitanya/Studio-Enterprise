// Real API check: does ANY of our SharePoint connectors have a stored OAuth
// refresh token at all? DataConnectorService.checkRefreshToken is a genuine,
// documented (if deprecated) REST method confirmed present in the live
// v1alpha discovery document — unlike AcquireAndStoreRefreshToken, which is
// only ever mentioned in prose (another method's description), never listed
// as its own callable REST method. That's a meaningful distinction: it means
// "store a NEW refresh token" is Console-only, but "check if one exists" is
// something we CAN call directly, right now, for a definitive answer.
//   npx tsx src/spikes/_diag_check_refresh_token.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = '231705905417';
const COLLECTIONS = ['sp-filefuze-cddd60ea5b99', 'filefuze-testingpermissions-test_1785742170965', 'sharepointconnector_1785956981552'];

async function check(saToken: string, collectionId: string) {
  const url = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/${collectionId}/dataConnector:checkRefreshToken`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  console.log(`\n>>> ${collectionId}`);
  console.log('status:', res.status);
  console.log(await res.text());
}

async function main() {
  const saToken = await getSaToken();
  for (const c of COLLECTIONS) await check(saToken, c);
}
main().catch((e) => console.error('FAILED:', e.message));
