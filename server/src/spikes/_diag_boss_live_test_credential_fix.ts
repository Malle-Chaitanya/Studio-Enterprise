import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { resolveScope } from '../services/scope.js';
import { runMigration } from '../orchestrator.js';
import type { MigrationResult } from '../types.js';

const ENV_URL = 'https://org32322095.crm.dynamics.com';
const BOT_ID = 'bdf9b817-9b90-f111-b8da-0022480b1f83'; // Migrate Advisor

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');

  const plan = await resolveScope(s, { kind: 'agents', env: ENV_URL, botIds: [BOT_ID] }, {});
  console.log(`Resolved plan: ${plan.totalAgents} agent(s)`);
  plan.forceRedeploy = true; // PATCH the existing agent — no creation-quota spend
  plan.acknowledgeAclLoss = true; // already acknowledged in prior runs for this agent

  console.log('\nRunning LIVE migration (forceRedeploy) against Migrate Advisor...\n');
  let finalResult: MigrationResult | null = null;
  for await (const evt of runMigration(s, plan)) {
    if (evt.type === 'log') console.log(`  [${evt.level}] ${evt.msg}`);
    if (evt.type === 'tool_start') console.log(`  -> ${evt.tool}: ${evt.msg}`);
    if (evt.type === 'tool_end') console.log(`  <- ${evt.tool}: ${evt.ok ? 'ok' : 'FAILED'} ${evt.msg}`);
    if (evt.type === 'agent') finalResult = evt.result;
    if (evt.type === 'done') console.log(`\nDONE: ${evt.summary}`);
  }

  console.log('\n================ RESULT ================');
  console.log(JSON.stringify(finalResult, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message, e.stack); process.exit(1); });
