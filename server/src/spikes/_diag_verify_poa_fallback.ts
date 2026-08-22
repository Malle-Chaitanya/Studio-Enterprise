/** Verifies the new POA-table fallback in readAgentPermissions() actually recovers
 *  alex@filefuze.co's Editor share on "Migrate Advisor" — the exact real-migration case
 *  that showed 0 shares and a misleading "insufficient privilege" note before this fix.
 *   npx tsx src/spikes/_diag_verify_poa_fallback.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { readAgentPermissions } from '../services/dataverse.js';

const MIGRATE_ADVISOR_BOT_ID = 'ca57b355-d08b-f111-8076-0022480b19e9';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    const perms = await readAgentPermissions(env.url, token, MIGRATE_ADVISOR_BOT_ID);
    if (perms.readError?.includes('not a member of the organization')) continue;
    console.log(`\n=== ENV: ${env.name} (${env.url}) ===`);
    console.log(JSON.stringify(perms, null, 2));
    process.exit(0);
  }
  throw new Error('no matching environment found');
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
