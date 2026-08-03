/**
 * Drives the REAL two-phase orchestrator and inspects the DB staging.
 *   npx tsx src/spikes/_test_pipeline.ts <sessionId> dry    # 5 agents, dry run (stage only)
 *   npx tsx src/spikes/_test_pipeline.ts <sessionId> live   # 1 agent, extract→stage→insert
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import { runMigration } from '../orchestrator.js';
import type { ResolvedPlan } from '../types.js';

const SESSION_ID = process.argv[2];
const MODE = process.argv[3] === 'live' ? 'live' : 'dry';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').findOne({ _id: SESSION_ID as never })) as Session | null;
  if (!s) throw new Error('session not found');

  // First env with agents.
  let unit: { envUrl: string; envName: string; bots: { botid: string; name: string }[] } | null = null;
  for (const env of s.environments ?? []) {
    try {
      const t = await clientCredsToken(s.tenantId ?? '', env.url);
      const bots = await listBots(env.url, t);
      if (bots.length) { unit = { envUrl: env.url, envName: env.name, bots }; break; }
    } catch { /* skip inaccessible */ }
  }
  if (!unit) throw new Error('no agents');

  const take = MODE === 'live' ? 1 : 5;
  const bots = unit.bots.slice(0, take);
  const plan: ResolvedPlan = {
    units: [{ envUrl: unit.envUrl, envName: unit.envName, bots }],
    totalAgents: bots.length,
    destination: { prefixWithEnv: false },
    dryRun: MODE === 'dry',
  };

  console.log(`\n=== ${MODE.toUpperCase()} pipeline test · ${bots.length} agent(s) ===\n`);
  for await (const evt of runMigration(s, plan)) {
    if (evt.type === 'log') console.log(`[${evt.level}] ${evt.msg}`);
    else if (evt.type === 'progress') console.log(`  … ${evt.pct}% ${evt.msg}`);
    else if (evt.type === 'done') console.log(`\nDONE: ${evt.summary}`);
  }

  // Inspect the DB staging for the run we just executed.
  const run = await getDb().collection('migrationRuns').find({}).sort({ startTime: -1 }).limit(1).next();
  const runId = run?._id as unknown as string;
  const staged = await getDb().collection('stagedAgents').find({ runId }).toArray();
  console.log(`\n── stagedAgents for run ${runId} ──`);
  const byStatus: Record<string, number> = {};
  for (const r of staged) byStatus[r.status] = (byStatus[r.status] || 0) + 1;
  console.log(`  status counts: ${JSON.stringify(byStatus)}`);
  for (const r of staged.slice(0, 6)) {
    console.log(`  · ${r.name} → status=${r.status}${r.geminiAgentId ? ' agentId=' + r.geminiAgentId : ''}${r.error ? ' err=' + r.error : ''}`);
  }
  const results = await getDb().collection('migrationResults').countDocuments({ runId });
  console.log(`  migrationResults rows: ${results}`);
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
