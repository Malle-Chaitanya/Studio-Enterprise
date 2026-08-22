/**
 * Do the space names the knowledge path failed on actually exist on the site?
 *
 * "None of the requested spaces found: Migration Knowledge Source" has two very different
 * causes — the space is genuinely absent, or the matcher is too strict (exact name only, no
 * key, no partial). Only one of those is our bug, and the message reads identically either way.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

const WANTED = ['Migration Knowledge Source', 'CloudFuze Migration Docs'];

await connectMongo();
const db = getDb();
const rec = (await db.collection('connectorCredentials').findOne({ connectorId: 'shared_confluence' })) as
  | { project?: string; secretIds?: Record<string, string> } | null;
const project = rec?.project ?? 'studio-enterprise-migration';
const saToken = await getSaToken();
const c: Record<string, string> = {};
for (const [f, id] of Object.entries(rec?.secretIds ?? {})) {
  const g = await getEntraSecret(saToken, `projects/${project}/secrets/${id}/versions/latest`);
  if (g.ok && g.plaintext) c[f] = g.plaintext;
}
let base = c.base_url.replace(/\/$/, '');
if (base.toLowerCase().endsWith('/wiki')) base = base.slice(0, -5);
const auth = Buffer.from(`${c.email}:${c.api_token}`).toString('base64');

const all: Array<{ key: string; name: string }> = [];
for (let start = 0; start < 500; start += 100) {
  const res = await fetch(`${base}/wiki/rest/api/space?limit=100&start=${start}`, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
  });
  if (!res.ok) { console.log(`listing failed ${res.status}`); break; }
  const j = (await res.json()) as { results?: Array<{ key: string; name: string }> };
  const batch = j.results ?? [];
  all.push(...batch);
  if (batch.length < 100) break;
}
console.log(`${all.length} space(s) on ${base}\n`);

for (const want of WANTED) {
  const exact = all.filter((s) => s.name.toLowerCase().trim() === want.toLowerCase().trim());
  const byKey = all.filter((s) => s.key.toLowerCase() === want.toLowerCase());
  const partial = all.filter((s) => s.name.toLowerCase().includes(want.toLowerCase().split(' ')[0]));
  console.log(`"${want}"`);
  console.log(`   exact name match : ${exact.length ? exact.map((s) => `${s.name} (${s.key})`).join(', ') : 'NONE'}`);
  console.log(`   key match        : ${byKey.length ? byKey.map((s) => s.key).join(', ') : 'NONE'}`);
  console.log(`   partial (word 1) : ${partial.length ? partial.slice(0, 6).map((s) => `${s.name} (${s.key})`).join(', ') : 'NONE'}`);
  console.log('');
}
console.log('all space names:');
for (const s of all.filter((x) => !x.key.startsWith('~'))) console.log(`   ${s.key.padEnd(24)} ${s.name}`);
process.exit(0);
