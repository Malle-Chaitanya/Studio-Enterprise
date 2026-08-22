/**
 * Does the stored Confluence credential work, and which of the four operations real agents
 * call can actually be served today?
 *
 * The knowledge path has failed 14 times with "403 listing spaces" and "None of the requested
 * spaces found", so the credential itself is the first thing to establish — building tools on
 * top of a credential that cannot list spaces would just move the failure.
 *
 * Never prints the token.
 *
 *   cd server && npx tsx src/spikes/_diag_confluence_live.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

await connectMongo();
const db = getDb();
// Resolved from the CREDENTIAL RECORD, not from a session. `migrationSessions` has a Mongo
// TTL, so a session-derived lookup reports "nothing configured" the moment it expires — which
// is what this spike did on its first run, minutes after the credentials were provably there.
const rec = (await db.collection('connectorCredentials').findOne({ connectorId: 'shared_confluence' })) as
  | { appUserId?: string; project?: string; secretIds?: Record<string, string> } | null;
const project = rec?.project ?? 'studio-enterprise-migration';
const saToken = await getSaToken();
console.log(`appUserId : ${rec?.appUserId}`);
if (!rec) { console.log('no Confluence credential recorded'); process.exit(1); }

const v: Record<string, string> = {};
for (const [field, secretId] of Object.entries(rec.secretIds ?? {})) {
  const got = await getEntraSecret(saToken, `projects/${project}/secrets/${secretId}/versions/latest`);
  if (got.ok && got.plaintext) v[field] = got.plaintext;
}
let base = (v.base_url ?? '').replace(/\/$/, '');
if (base.toLowerCase().endsWith('/wiki')) base = base.slice(0, -5);
console.log(`base_url : ${base}`);
console.log(`email    : ${v.email}`);
console.log(`token    : ${v.api_token ? `present (${v.api_token.length} chars)` : 'MISSING'}\n`);

const auth = Buffer.from(`${v.email}:${v.api_token}`).toString('base64');
const H = { Authorization: `Basic ${auth}`, Accept: 'application/json' };

async function probe(label: string, path: string) {
  try {
    const res = await fetch(`${base}${path}`, { headers: H });
    const body = await res.text();
    if (!res.ok) {
      console.log(`  ${String(res.status).padEnd(4)} ${label.padEnd(30)} ${body.replace(/\s+/g, ' ').slice(0, 120)}`);
      return null;
    }
    const j = JSON.parse(body) as { results?: unknown[] };
    console.log(`  ok   ${label.padEnd(30)} ${(j.results ?? []).length} result(s)`);
    return j;
  } catch (e) {
    console.log(`  ERR  ${label.padEnd(30)} ${(e as Error).message.slice(0, 100)}`);
    return null;
  }
}

// One probe per operation a real agent calls, plus both API generations — Confluence Cloud
// has v1 (/rest/api) and v2 (/api/v2), and they differ in what they will return.
const spaces = await probe('GetSpaces (v1)', '/wiki/rest/api/space?limit=25');
await probe('GetSpaces (v2)', '/wiki/api/v2/spaces?limit=25');
await probe('GetPages (v1 search)', '/wiki/rest/api/content/search?cql=' + encodeURIComponent('type = page') + '&limit=5');
await probe('GetPages (v2)', '/wiki/api/v2/pages?limit=5');
const key = ((spaces?.results ?? [])[0] as { key?: string } | undefined)?.key;
if (key) {
  console.log(`\n  first space key: ${key}`);
  await probe('GetPagesBySpace (v1)', `/wiki/rest/api/content?spaceKey=${key}&limit=5`);
} else {
  console.log('\n  no space key returned — GetPagesBySpace cannot be probed');
}
process.exit(0);
