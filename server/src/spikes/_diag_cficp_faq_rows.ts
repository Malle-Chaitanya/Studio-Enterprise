/** Resolve + pull real rows for the "CF ICP Profile, FAQ Entry" knowledge
 * source on the Migrate Advisor agent (sourceId bdf9b817-9b90-f111-b8da-0022480b1f83,
 * skillConfiguration CFICPProfile_FAQEntry_oFb1VjgcrvwKRpkyJrtUG). Two-table
 * source ("FAQ Entry" + "CF ICP Profile") — dumps both.
 *   npx tsx src/spikes/_diag_cficp_faq_rows.ts [sessionId]
 * READ-ONLY.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveTableSearchTarget, exportTableRows } from '../services/dataverseTableExport.js';

const SESSION_ID = process.argv[2];
const DV_TABLE_SEARCH_NAME = 'CFICPProfile_FAQEntry_oFb1VjgcrvwKRpkyJrtUG';

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

  const { targets, unconfigured } = await resolveTableSearchTarget(env.url, token, DV_TABLE_SEARCH_NAME);
  console.log(`unconfigured=${unconfigured}  targets=${JSON.stringify(targets)}`);

  for (const t of targets) {
    console.log(`\n=== ${t.entitySetName} (pk=${t.primaryKeyAttr}) ===`);
    const rows = await exportTableRows(env.url, token, t.entitySetName, t.primaryKeyAttr, 20);
    console.log(`Fetched ${rows.length} row(s):`);
    for (const r of rows) console.log(JSON.stringify(r.data).slice(0, 500));
  }

  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});