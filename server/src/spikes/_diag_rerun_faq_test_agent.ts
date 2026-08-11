/**
 * Re-run the live migration for "CS_GE Knowledge Test Agent" only, calling the
 * real orchestrator directly (bypassing the HTTP/session-TTL layer — this is
 * the exact same execute() path the UI's /api/migrate/plan + /stream hit),
 * to test the groundingDataStores fix (orchestrator.ts, low-code fallback
 * branch) after the user manually deleted the previous agent in Console.
 *
 *   npx tsx src/spikes/_diag_rerun_faq_test_agent.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { runMigration } from '../orchestrator.js';
import { resolveScope } from '../services/scope.js';
import { getSaToken } from '../auth/google.js';
import type { Session } from '../sessionStore.js';
import type { MigrationScope, DestinationOptions } from '../types.js';

const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const BOT_ID = 'ca57b355-d08b-f111-8076-0022480b19e9'; // CS_GE Knowledge Test Agent
const GEMINI_PROJECT = '231705905417';
const GEMINI_ENGINE = 'gemini-enterprise-17847887_1784788734248';
const G_EMAIL = 'zara@storefuze.com';

async function main() {
  await connectMongo();
  // Confirm the SA can impersonate before committing to a full run.
  await getSaToken(G_EMAIL);

  const session: Session = {
    step: 'ready',
    createdAt: Date.now(),
    tenantId: TENANT_ID,
    gEmail: G_EMAIL,
    geminiProject: GEMINI_PROJECT,
    saOk: true,
    environments: [{ name: 'CloudFuze Migration Test', url: ENV_URL, id: ENV_URL }],
  };

  const scope: MigrationScope = {
    kind: 'selection',
    units: [{ env: ENV_URL, botIds: [BOT_ID] }],
  };
  const destination: DestinationOptions = {
    environmentMap: {
      [ENV_URL]: { project: GEMINI_PROJECT, engine: GEMINI_ENGINE, assistant: 'default_assistant' },
    },
  };

  const plan = await resolveScope(session, scope, destination);
  plan.dryRun = false;
  console.log(`Plan: ${plan.totalAgents} agent(s) across ${plan.units.length} environment(s)\n`);
  if (!plan.totalAgents) {
    console.log('NOTHING TO MIGRATE — check bot id / env / tenant.');
    process.exit(1);
  }

  for await (const evt of runMigration(session, plan)) {
    if (evt.type === 'log') {
      console.log(`[${evt.level}] ${evt.msg}`);
    } else if (evt.type === 'progress') {
      console.log(`[progress ${evt.pct}%] ${evt.msg}`);
    } else if (evt.type === 'agent') {
      console.log(`[result] ${JSON.stringify(evt.result)}`);
    } else if (evt.type === 'done') {
      console.log(`\n[DONE] ${evt.summary}`);
      console.log(JSON.stringify(evt.results, null, 2));
    }
  }
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message, e.stack);
  process.exit(1);
});
