/** Follow-up #3: get the real attribute names on dvtablesearchentity /
 * dvtablesearchattribute (my FK-field guess `_dvtablesearchid_value` was
 * wrong), then re-query using the correct lookup column.
 *   npx tsx src/spikes/_diag_faqentry_linkage3.ts [sessionId]
 * READ-ONLY.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';

const SESSION_ID = process.argv[2];
const DVTABLESEARCH_ID = '8e515ac8-dc8c-4f5c-a4a9-443ca28419c1';

async function dvGet(url: string, token: string, path: string) {
  const res = await fetch(`${url}/api/data/v9.2/${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return JSON.parse(text) as { value?: Record<string, unknown>[] } & Record<string, unknown>;
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

  for (const entity of ['dvtablesearchentity', 'dvtablesearchattribute']) {
    console.log(`\n--- ${entity} attributes ---`);
    try {
      const attrs = await dvGet(env.url, token, `EntityDefinitions(LogicalName='${entity}')/Attributes?$select=LogicalName,AttributeType`);
      console.log((attrs.value ?? []).map((a) => `${a.LogicalName}(${a.AttributeType})`).join(', '));
    } catch (e) {
      console.log('failed:', (e as Error).message);
    }
  }

  console.log('\n--- ALL rows in dvtablesearchentities (small table, no filter) ---');
  try {
    const r = await dvGet(env.url, token, `dvtablesearchentities?$top=20`);
    console.log(`${r.value?.length ?? 0} row(s) total in table`);
    const mine = (r.value ?? []).filter((row) => JSON.stringify(row).includes(DVTABLESEARCH_ID));
    console.log(`${mine.length} row(s) matching our dvtablesearchid`);
    for (const row of mine) console.log(JSON.stringify(row, null, 2));
    if (!mine.length && r.value?.length) console.log('sample row (for shape):', JSON.stringify(r.value[0], null, 2));
  } catch (e) {
    console.log('failed:', (e as Error).message);
  }

  console.log('\n--- ALL rows in dvtablesearchattributes (small table, no filter) ---');
  try {
    const r = await dvGet(env.url, token, `dvtablesearchattributes?$top=20`);
    console.log(`${r.value?.length ?? 0} row(s) total in table`);
    const mine = (r.value ?? []).filter((row) => JSON.stringify(row).includes(DVTABLESEARCH_ID));
    console.log(`${mine.length} row(s) matching our dvtablesearchid`);
    for (const row of mine) console.log(JSON.stringify(row, null, 2));
    if (!mine.length && r.value?.length) console.log('sample row (for shape):', JSON.stringify(r.value[0], null, 2));
  } catch (e) {
    console.log('failed:', (e as Error).message);
  }

  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
