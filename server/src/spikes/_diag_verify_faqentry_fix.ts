/** Verify the resolveTableSearchTarget fix against the real "FAQ Entry" case
 * from the live log — should now report `unconfigured: true` (honest) instead
 * of the old misleading "EntityDefinitions lookup failed".
 *   npx tsx src/spikes/_diag_verify_faqentry_fix.ts [sessionId]
 * READ-ONLY.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveTableSearchTarget } from '../services/dataverseTableExport.js';

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

  const result = await resolveTableSearchTarget(env.url, token, NEEDLE);
  console.log('Result for the broken "FAQ Entry" source:', JSON.stringify(result));

  // Also sanity-check against the real "Lead" example we found earlier — this
  // one IS configured, so it should resolve to a real entitySetName/primaryKeyAttr.
  const leadResult = await resolveTableSearchTarget(env.url, token, '__no_such_name__placeholder__');
  console.log('Result for a definitely-nonexistent name (sanity check, should be unconfigured:false):', JSON.stringify(leadResult));

  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
