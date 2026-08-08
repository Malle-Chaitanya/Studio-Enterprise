/** End-to-end verification: resolveTableSearchTarget found cr88d_faqentries /
 * cr88d_faqentryid for the "FAQ Entry" source — confirm exportTableRows can
 * actually pull real rows from it (the full pipeline, not just resolution).
 *   npx tsx src/spikes/_diag_verify_faqentry_rows.ts [sessionId]
 * READ-ONLY.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveTableSearchTarget } from '../services/dataverseTableExport.js';
import { exportTableRows } from '../services/dataverseTableExport.js';

const SESSION_ID = process.argv[2];
const NEEDLE = 'FAQEntry_uPI4VpDKvs4NXzz7WimSu';

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

  const { target } = await resolveTableSearchTarget(env.url, token, NEEDLE);
  if (!target) throw new Error('resolution failed unexpectedly');
  console.log('Resolved target:', JSON.stringify(target));

  const rows = await exportTableRows(env.url, token, target.entitySetName, target.primaryKeyAttr, 10);
  console.log(`Fetched ${rows.length} row(s):`);
  for (const r of rows) console.log(JSON.stringify(r).slice(0, 300));

  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
