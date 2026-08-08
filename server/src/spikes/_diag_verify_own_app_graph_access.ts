// Verifies OUR OWN registered app (config.MS_CLIENT_ID, not "ConnectorsTest")
// can actually download the target SharePoint file — the exact mechanism the
// real orchestrator pipeline will use via graphToken()/clientCredsToken().
import 'dotenv/config';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveShareUrlSmart, downloadDriveItemBytes } from '../services/graphFiles.js';

const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const URL = 'https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions/daily_queries.txt';

async function main() {
  const graphToken = await clientCredsToken(TENANT_ID, 'https://graph.microsoft.com');
  console.log('got token via OUR OWN registered app (config.MS_CLIENT_ID)');
  const resolved = await resolveShareUrlSmart(graphToken, URL);
  console.log('resolved:', JSON.stringify(resolved, null, 2));
  if (resolved.item) {
    const bytes = await downloadDriveItemBytes(graphToken, resolved.item);
    console.log('downloaded bytes:', bytes?.bytes.length);
  }
}
main().catch((e) => console.error('FAILED:', e.message));
