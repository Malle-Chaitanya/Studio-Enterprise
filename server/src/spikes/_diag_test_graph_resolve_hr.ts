import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveShareUrlSmart, downloadDriveItemBytes } from '../services/graphFiles.js';

const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const URLS = [
  'https://filefuze-my.sharepoint.com/personal/erik_filefuze_co/Documents/HR%20Neutara%20Policy/WFH%20Policy-%20Neutara%20Technologies.pdf',
  'https://filefuze-my.sharepoint.com/personal/erik_filefuze_co/Documents/HR%20Neutara%20Policy/Neutara%20HR%20Leave%20Policies_2024.pdf',
];

async function main() {
  await connectMongo();
  const graphToken = await clientCredsToken(TENANT_ID, 'https://graph.microsoft.com');
  console.log('got graph token, length=', graphToken.length);

  for (const url of URLS) {
    console.log(`\n=== ${url} ===`);
    try {
      const resolved = await resolveShareUrlSmart(graphToken, url);
      console.log('resolveShareUrlSmart:', JSON.stringify(resolved));
      if (resolved.kind === 'file' || resolved.kind === 'folder-single-file') {
        const bytes = await downloadDriveItemBytes(graphToken, resolved.item, 2);
        console.log('download result:', bytes ? `${bytes.bytes.length} bytes, ${bytes.contentType}` : 'null');
      }
    } catch (e) {
      const err = e as Error & { cause?: unknown };
      console.log('THREW:', err.message, 'cause:', err.cause);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FATAL', e); process.exit(1); });
