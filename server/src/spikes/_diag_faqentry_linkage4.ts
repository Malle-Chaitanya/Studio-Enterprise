/** Follow-up #4: confirmed dvtablesearchentity(_dvtablesearch_value=X).entitylogicalname
 * is the real target table field, and OUR dvtablesearchid has ZERO child rows (genuinely
 * unconfigured on the customer's side). Last check: does the bot's `configuration` JSON
 * blob (already fetched successfully elsewhere) contain the agent's authored description
 * text, so Error 3's fix can parse it out instead of querying a non-existent DB column?
 *   npx tsx src/spikes/_diag_faqentry_linkage4.ts [sessionId]
 * READ-ONLY.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const SESSION_ID = process.argv[2];
const BOTID = 'ca57b355-d08b-f111-8076-0022480b19e9';

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>;
}

async function main() {
  await connectMongo();
  const coll = getDb().collection('migrationSessions');
  const s = (SESSION_ID
    ? await coll.findOne({ _id: SESSION_ID as never })
    : await coll.find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session found');
  const env = (s.environments ?? []).find((e) => e.url.includes('org32322095')) ?? s.environments?.[0];
  if (!env) throw new Error('no environment on session');
  const token = await clientCredsToken(s.tenantId ?? '', env.url);

  const rec = await dvGet(env.url, token, `bots(${BOTID})?$select=configuration`);
  const raw = String(rec.configuration ?? '');
  console.log('configuration length:', raw.length);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    console.log('not valid JSON:', (e as Error).message);
    console.log(raw.slice(0, 500));
    process.exit(0);
  }
  // Walk the object looking for keys that look description-ish, print key path + value.
  const hits: { path: string; value: string }[] = [];
  const walk = (node: unknown, path: string, depth: number) => {
    if (depth > 6 || node == null) return;
    if (typeof node === 'string') {
      if (/desc/i.test(path)) hits.push({ path, value: node.slice(0, 200) });
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${path}[${i}]`, depth + 1));
      return;
    }
    if (typeof node === 'object') {
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        walk(v, path ? `${path}.${k}` : k, depth + 1);
      }
    }
  };
  walk(parsed, '', 0);
  console.log(`Found ${hits.length} description-ish key(s):`);
  for (const h of hits) console.log(`  ${h.path} = ${JSON.stringify(h.value)}`);
  console.log('\nTop-level keys of configuration JSON:', Object.keys(parsed as object));

  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
