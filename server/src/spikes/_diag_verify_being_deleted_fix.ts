import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { migrateFileToDocumentStore } from '../services/knowledgeDataStoreExecutor.js';
import { resolveShareUrlSmart, downloadDriveItemBytes } from '../services/graphFiles.js';

const PROJECT = '231705905417';
const AGENT_SOURCE_ID = 'ee2ea155-208c-f111-ab0f-0022480a981d';
const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const URL = 'https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions/daily_queries.txt';

async function main() {
  const saToken = await getSaToken();
  const graphToken = await clientCredsToken(TENANT_ID, 'https://graph.microsoft.com');
  const resolved = await resolveShareUrlSmart(graphToken, URL);
  if (!resolved.item) throw new Error('could not resolve file');
  const bytes = await downloadDriveItemBytes(graphToken, resolved.item);
  if (!bytes) throw new Error('download failed');

  const result = await migrateFileToDocumentStore(PROJECT, saToken, AGENT_SOURCE_ID, {
    name: resolved.item.name,
    bytes: bytes.bytes,
    mimeType: bytes.contentType || 'text/plain',
  });
  console.log(JSON.stringify(result, null, 2));
}
main().catch((e) => console.error('FAILED:', e.message));
