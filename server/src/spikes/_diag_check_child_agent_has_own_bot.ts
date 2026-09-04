/**
 * Real-time check: does "Meeting Scheduler Agent" have its OWN separate `bot`
 * record in Dataverse, or does it truly have no independent existence beyond
 * being a botcomponent row under WorkMate? Confirms/denies the "no independent
 * identity" claim directly, not by inference.
 *
 * Run: cd server && npx tsx src/spikes/_diag_check_child_agent_has_own_bot.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('No session');
  for (const env of s.environments ?? []) {
    let token: string;
    try { token = await clientCredsToken(s.tenantId ?? '', env.url); } catch { continue; }
    let bots;
    try { bots = await listBots(env.url, token); } catch { continue; }
    if (!bots.find((b) => b.name === 'WorkMate')) continue;

    console.log(`ALL bots in this environment (${bots.length} total):`);
    for (const b of bots) console.log(`  - "${b.name}" (botid=${b.botid})`);

    const match = bots.find((b) => b.name.toLowerCase().includes('meeting') || b.name.toLowerCase().includes('scheduler'));
    console.log(`\nSeparate bot record for "Meeting Scheduler Agent"? ${match ? 'FOUND: ' + JSON.stringify(match) : 'NOT FOUND — no separate bot record exists.'}`);
    process.exit(0);
  }
  console.error('WorkMate not found.');
  process.exit(1);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
