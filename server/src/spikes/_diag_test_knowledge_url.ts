import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveShareUrl, encodeShareId } from '../services/graphFiles.js';

const URL_TO_TEST = 'https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions';
const GRAPH = 'https://graph.microsoft.com/v1.0';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');

  const graphToken = await clientCredsToken(s.tenantId ?? '', 'https://graph.microsoft.com');

  console.log(`Testing URL: ${URL_TO_TEST}`);
  console.log(`Encoded share id: ${encodeShareId(URL_TO_TEST)}`);

  // Try the existing file-only resolver first.
  const asFile = await resolveShareUrl(graphToken, URL_TO_TEST);
  console.log('\nresolveShareUrl (file-only) result:', JSON.stringify(asFile, null, 2));

  // Now hit the raw shares/{id}/driveItem endpoint directly, unfiltered, to see
  // EXACTLY what Graph returns (file vs folder vs something else) regardless
  // of our current file-only filter.
  const shareId = encodeShareId(URL_TO_TEST);
  const res = await fetch(
    `${GRAPH}/shares/${shareId}/driveItem?$select=id,name,size,file,folder,parentReference,webUrl,lastModifiedDateTime`,
    { headers: { Authorization: `Bearer ${graphToken}` } },
  );
  console.log(`\nRaw shares/{id}/driveItem -> ${res.status}`);
  const raw = (await res.json()) as { folder?: unknown; id?: string; parentReference?: { driveId?: string } };
  console.log(JSON.stringify(raw, null, 2));

  // If it's a folder, list its children.
  if (raw.folder && raw.id && raw.parentReference?.driveId) {
    const childRes = await fetch(`${GRAPH}/drives/${raw.parentReference.driveId}/items/${raw.id}/children`, {
      headers: { Authorization: `Bearer ${graphToken}` },
    });
    const children = await childRes.json();
    console.log('\nFolder children:');
    console.log(JSON.stringify(children, null, 2));
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
