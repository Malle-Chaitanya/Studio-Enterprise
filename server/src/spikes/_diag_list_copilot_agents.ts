/** List every Copilot agent in the cached session's environment. Read-only.
 *  npx tsx src/spikes/_diag_list_copilot_agents.ts [filter] */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import type { Session } from '../sessionStore.js';
const F = (process.argv[2] ?? '').toLowerCase();
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ dvOrgUrl: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await clientCredsToken(s!.tenantId!, s!.dvOrgUrl!);
const bots = await listBots(s!.dvOrgUrl!, token);
console.log(`${bots.length} agents in ${s!.dvOrgUrl}\n`);
for (const b of bots) {
  if (F && !b.name.toLowerCase().includes(F)) continue;
  console.log(`  ${b.name}   [${b.botid}]`);
}
process.exit(0);
