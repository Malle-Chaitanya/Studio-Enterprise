/**
 * How many environments does this tenant actually have, and how many agents in each?
 *
 * Every _diag_* spike so far hardcoded a two-environment filter
 * (/orga243378d|org32322095/), so every coverage number reported was a number about TWO
 * environments, not about the tenant. Establish the real denominator before quoting
 * another percentage.
 *
 * Read-only.
 *
 * npx tsx src/spikes/_diag_envs.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as
  { tenantId?: string; environments?: Array<{ url: string; name: string; id: string }> } | null;
const tenantId = cache!.tenantId!;
const envs = cache!.environments ?? [];

console.log(`\ntenant has ${envs.length} environment(s) in environmentsCache\n`);
let total = 0;
for (const e of envs) {
  const covered = /orga243378d|org32322095/.test(e.url) ? 'covered by past diags' : '** NOT COVERED **';
  let n: string;
  try {
    const token = await clientCredsToken(tenantId, e.url);
    const bots = await listBots(e.url, token);
    n = `${bots.length} agent(s)`;
    total += bots.length;
  } catch (err) {
    n = `UNREADABLE: ${(err as Error).message.slice(0, 60)}`;
  }
  console.log(`  ${(e.name ?? '(unnamed)').slice(0, 32).padEnd(32)} ${n.padEnd(26)} ${covered}`);
  console.log(`     ${e.url}`);
}
console.log(`\ntotal agents across all readable environments: ${total}`);
process.exit(0);
