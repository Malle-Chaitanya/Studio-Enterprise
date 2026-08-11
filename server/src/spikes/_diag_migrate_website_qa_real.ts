/**
 * Runs the REAL two-phase orchestrator (runMigration, not a hand-rolled
 * copy) for exactly one real agent — "Website Q&A" (sourceId
 * 5937b695-7e3e-f111-88b4-6045bd08b5e6), the only agent in this environment
 * with an actual Dataverse knowledge source. Live insert (not dry run).
 *   npx tsx src/spikes/_diag_migrate_website_qa_real.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import { runMigration } from '../orchestrator.js';
import type { ResolvedPlan } from '../types.js';

const TARGET_SOURCE_ID = '5937b695-7e3e-f111-88b4-6045bd08b5e6';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({ tenantId: '807d6772-847c-40e2-9bec-e2c930b3a42e' }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('session not found for this tenant');
  console.log(`session tenant=${s.tenantId} geminiProject=${s.geminiProject}`);

  let unit: { envUrl: string; envName: string; bots: { botid: string; name: string }[] } | null = null;
  for (const env of s.environments ?? []) {
    try {
      const t = await clientCredsToken(s.tenantId ?? '', env.url);
      const bots = await listBots(env.url, t);
      const match = bots.find((b) => b.botid === TARGET_SOURCE_ID);
      if (match) { unit = { envUrl: env.url, envName: env.name, bots: [match] }; break; }
    } catch (e) {
      console.log(`  (skip env ${env.name}: ${(e as Error).message})`);
    }
  }
  if (!unit) throw new Error('target agent not found in any environment on this session');
  console.log(`Found "Website Q&A" in env "${unit.envName}" (${unit.envUrl})`);

  const plan: ResolvedPlan = {
    units: [{ envUrl: unit.envUrl, envName: unit.envName, bots: unit.bots }],
    totalAgents: 1,
    destination: {},
    dryRun: false,
  };

  console.log('\n=== LIVE migration: "Website Q&A" ===\n');
  for await (const evt of runMigration(s, plan)) {
    if (evt.type === 'log') console.log(`[${evt.level}] ${evt.msg}`);
    else if (evt.type === 'progress') console.log(`  … ${evt.pct}% ${evt.msg}`);
    else if (evt.type === 'agent') console.log(`  [agent] ${JSON.stringify(evt)}`);
    else if (evt.type === 'done') console.log(`\nDONE: ${evt.summary}`);
  }

  const run = await getDb().collection('migrationRuns').find({}).sort({ startTime: -1 }).limit(1).next();
  const runId = run?._id as unknown as string;
  const results = await getDb().collection('migrationResults').find({ runId }).toArray();
  console.log(`\n── migrationResults for run ${runId} ──`);
  console.log(JSON.stringify(results, null, 2));
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message, e.stack); process.exit(1); });
