/** Follow-up #2: the dvtablesearch record's own FK fields (connectionreference,
 * knowledgesourceprofileid, knowledgesourceconsumerid, knowledgeconfig) were
 * ALL null for "FAQEntry_uPI4VpDKvs4NXzz7WimSu" — check its normalized child
 * tables (dvtablesearchentity / dvtablesearchattribute) for the real target
 * table, and dump the FULL bot attribute list (not just desc-filtered) to be
 * certain no description-like column was missed.
 *   npx tsx src/spikes/_diag_faqentry_linkage2.ts [sessionId]
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

  console.log('--- dvtablesearchentity rows for this dvtablesearchid ---');
  try {
    const r = await dvGet(
      env.url,
      token,
      `dvtablesearchentities?$filter=_dvtablesearchid_value eq ${DVTABLESEARCH_ID}`,
    );
    console.log(`${r.value?.length ?? 0} row(s)`);
    for (const row of r.value ?? []) console.log(JSON.stringify(row, null, 2));
  } catch (e) {
    console.log('query failed:', (e as Error).message);
  }

  console.log('\n--- dvtablesearchattribute rows for this dvtablesearchid ---');
  try {
    const r = await dvGet(
      env.url,
      token,
      `dvtablesearchattributes?$filter=_dvtablesearchid_value eq ${DVTABLESEARCH_ID}`,
    );
    console.log(`${r.value?.length ?? 0} row(s)`);
    for (const row of r.value ?? []) console.log(JSON.stringify(row, null, 2));
  } catch (e) {
    console.log('query failed (trying without FK filter):', (e as Error).message);
  }

  console.log('\n--- ALL bot entity attributes (unfiltered) ---');
  try {
    const attrs = await dvGet(env.url, token, `EntityDefinitions(LogicalName='bot')/Attributes?$select=LogicalName`);
    console.log((attrs.value ?? []).map((a) => a.LogicalName).sort().join(', '));
  } catch (e) {
    console.log('query failed:', (e as Error).message);
  }

  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
