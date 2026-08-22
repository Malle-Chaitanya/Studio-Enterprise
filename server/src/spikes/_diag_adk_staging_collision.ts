/**
 * Two concurrent ADK deploys produced two engines with the SAME toolset (2026-08-21):
 * "Hubspot agentt" got Email Manager's Outlook tools. The spec travels on argv, so the
 * suspect is the GCS staging path — the Vertex SDK writes the pickled agent to a FIXED
 * object name under the staging bucket, so a second concurrent deploy overwrites the first
 * before the container is built.
 *
 * This lists what is actually in the bucket and when each object was written. Fixed names
 * plus write times inside the same window is the collision.
 *
 *   cd server && npx tsx src/spikes/_diag_adk_staging_collision.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const bucket = (process.env.ADK_STAGING_BUCKET ?? '').replace(/^gs:\/\//, '').replace(/\/.*$/, '');
if (!bucket) throw new Error('ADK_STAGING_BUCKET not set');
console.log(`bucket: ${bucket}\n`);
const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
const r = await fetch(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?maxResults=200`, {
  headers: { Authorization: `Bearer ${token}` },
});
if (!r.ok) {
  console.log(`list -> ${r.status} ${(await r.text()).slice(0, 300)}`);
  process.exit(0);
}
const items = ((await r.json()) as { items?: Array<Record<string, string>> }).items ?? [];
items.sort((a, b) => String(b.updated).localeCompare(String(a.updated)));
for (const o of items.slice(0, 40)) {
  console.log(`  ${String(o.updated).slice(0, 19)}  gen=${o.generation}  ${(Number(o.size) / 1024).toFixed(0).padStart(7)}KB  ${o.name}`);
}
console.log(`\n${items.length} object(s). A REUSED name with several generations minutes apart is the overwrite.`);
process.exit(0);
