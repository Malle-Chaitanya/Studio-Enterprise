/**
 * Live test: can we actually fetch a SharePoint/OneDrive file via Microsoft
 * Graph, using the URL shown in Copilot Studio's "Knowledge URL" field?
 * Uses the SAME app-only token mechanism already used for Dataverse
 * (clientCredsToken), just pointed at Graph instead — no new auth code, this
 * either works with today's app registration or tells us exactly why not.
 *
 *   npx tsx src/spikes/_diag_fetch_via_graph.ts <url> [sessionId]
 *
 * Read-only against Microsoft Graph — does not modify anything.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const URL_ARG = process.argv[2];
const SESSION_ID = process.argv[3];
if (!URL_ARG) throw new Error('usage: _diag_fetch_via_graph.ts <sharepoint-or-onedrive-url> [sessionId]');

/** Graph's "shares/{id}" encoding: base64url of the URL, prefixed with "u!". */
function encodeShareId(url: string): string {
  const b64 = Buffer.from(url.trim(), 'utf8').toString('base64');
  const b64url = b64.replace(/=+$/, '').replace(/\//g, '_').replace(/\+/g, '-');
  return `u!${b64url}`;
}

async function main() {
  await connectMongo();
  const coll = getDb().collection('migrationSessions');
  const s = (SESSION_ID
    ? await coll.findOne({ _id: SESSION_ID as never })
    : await coll.find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');
  if (!s.tenantId) throw new Error('session has no tenantId');

  console.log('Getting app-only Graph token (same mechanism as Dataverse)...');
  let graphToken: string;
  try {
    graphToken = await clientCredsToken(s.tenantId, 'https://graph.microsoft.com');
    console.log('Token acquired OK.');
  } catch (e) {
    console.log('FAILED to get a Graph token at all:', (e as Error).message);
    process.exit(1);
  }

  const shareId = encodeShareId(URL_ARG);
  console.log(`\nResolving share -> driveItem: GET /v1.0/shares/${shareId}/driveItem`);
  const res = await fetch(
    `https://graph.microsoft.com/v1.0/shares/${shareId}/driveItem?$select=id,name,size,file,parentReference`,
    { headers: { Authorization: `Bearer ${graphToken}` } },
  );
  console.log('status:', res.status);
  const text = await res.text();
  console.log(text.slice(0, 1000));

  if (!res.ok) {
    process.exit(0);
  }

  const item = JSON.parse(text) as { id?: string; name?: string; parentReference?: { driveId?: string } };
  if (!item.id || !item.parentReference?.driveId) {
    console.log('Resolved but missing id/driveId — cannot proceed to download.');
    process.exit(0);
  }

  console.log(`\nDownloading content: GET /v1.0/drives/${item.parentReference.driveId}/items/${item.id}/content`);
  const dl = await fetch(
    `https://graph.microsoft.com/v1.0/drives/${item.parentReference.driveId}/items/${item.id}/content`,
    { headers: { Authorization: `Bearer ${graphToken}` } },
  );
  console.log('status:', dl.status);
  if (dl.ok) {
    const buf = Buffer.from(await dl.arrayBuffer());
    console.log(`SUCCESS: downloaded ${buf.length} bytes, contentType=${dl.headers.get('content-type')}`);
  } else {
    console.log((await dl.text()).slice(0, 500));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
