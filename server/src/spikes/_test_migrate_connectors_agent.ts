/**
 * Targeted end-to-end migration test for the "Microsoft Connectors" agent specifically —
 * not the first N bots in an environment, this exact one.
 *
 *   npx tsx src/spikes/_test_migrate_connectors_agent.ts <sessionId> dry
 *   npx tsx src/spikes/_test_migrate_connectors_agent.ts <sessionId> live
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
const TARGET_SOURCE_ID = '3193a7a6-c738-4987-ab05-34be2764f8f7';
const TARGET_NAME = /microsoft connectors/i;

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').findOne({ _id: SESSION_ID as never })) as Session | null;
  if (!s) throw new Error('session not found');

  let unit: { envUrl: string; envName: string; bots: { botid: string; name: string }[] } | null = null;
  for (const env of s.environments ?? []) {
    try {
      const t = await clientCredsToken(s.tenantId ?? '', env.url);
      const bots = await listBots(env.url, t);
      const match = bots.filter((b) => b.botid === TARGET_SOURCE_ID || TARGET_NAME.test(b.name));
      if (match.length) {
        unit = { envUrl: env.url, envName: env.name, bots: match };
        console.log(`Found in environment "${env.name}": ${match.map((b) => `${b.name} (${b.botid})`).join(', ')}`);
        break;
      }
    } catch (e) {
      console.log(`  · ${env.name}: probe failed (${(e as Error).message})`);
    }
  }
  if (!unit) throw new Error('"Microsoft Connectors" agent not found in any accessible environment');

  const plan: ResolvedPlan = {
    units: [{ envUrl: unit.envUrl, envName: unit.envName, bots: unit.bots }],
    totalAgents: unit.bots.length,
    destination: {},
    dryRun: MODE === 'dry',
  };

  console.log(`\n=== ${MODE.toUpperCase()} migration · "${unit.bots[0].name}" ===\n`);
  for await (const evt of runMigration(s, plan)) {
    if (evt.type === 'log') console.log(`[${evt.level}] ${evt.msg}`);
    else if (evt.type === 'progress') console.log(`  … ${evt.pct}% ${evt.msg}`);
    else if (evt.type === 'done') console.log(`\nDONE: ${JSON.stringify(evt.summary)}`);
  }

  const run = await getDb().collection('migrationRuns').find({}).sort({ startTime: -1 }).limit(1).next();
  const runId = run?._id as unknown as string;
  const staged = await getDb().collection('stagedAgents').find({ runId }).toArray();
  console.log(`\n── stagedAgents for run ${runId} ──`);
  for (const r of staged as any[]) {
    console.log(`  · ${r.displayName} → status=${r.status}${r.geminiAgentId ? ' agentId=' + r.geminiAgentId : ''}${r.error ? ' err=' + r.error : ''}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
