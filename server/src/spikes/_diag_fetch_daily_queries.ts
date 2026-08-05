import 'dotenv/config';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveShareUrlSmart, downloadDriveItemBytes } from '../services/graphFiles.js';

const TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const URL = 'https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions/daily_queries.txt';

async function main() {
  const token = await clientCredsToken(TENANT, 'https://graph.microsoft.com');
  const resolved = await resolveShareUrlSmart(token, URL);
  console.log('resolve kind:', resolved.kind);
  if (resolved.kind !== 'file' && resolved.kind !== 'folder-single-file') {
    console.log(JSON.stringify(resolved, null, 2));
    process.exit(0);
  }
  const item = resolved.item!;
  console.log('item:', JSON.stringify(item, null, 2));
  const dl = await downloadDriveItemBytes(token, item);
  if (!dl) { console.log('download failed'); process.exit(1); }
  console.log(`--- content (${dl.bytes.length} bytes, ${dl.contentType}) ---`);
  console.log(dl.bytes.toString('utf8'));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
