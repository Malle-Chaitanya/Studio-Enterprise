import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.tenantId || !s.environments?.length) throw new Error('no session');
  for (const env of s.environments) {
    let bots;
    try {
      const token = await clientCredsToken(s.tenantId, env.url);
      bots = await listBots(env.url, token);
    } catch { continue; }
    const bot = bots.find((b) => b.name === 'WorkMate');
    if (!bot) continue;
    const token = await clientCredsToken(s.tenantId, env.url);
    const ir = await extractAgent(env.url, token, bot);
    const child = ir.topics.find((t) => t.name === 'Meeting Scheduler Agent');
    console.log('isChildAgent:', child?.isChildAgent);
    console.log('modelDescription (routing):', child?.modelDescription);
    console.log('\nchildAgentInstructions (real authored behavior rules):\n', child?.childAgentInstructions);
    process.exit(0);
  }
  console.error('WorkMate not found');
  process.exit(1);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
