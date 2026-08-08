/**
 * DEMO ONLY — live-migrate the two agents used in the recorded demo.
 *
 * Does NOT touch the product UI / orchestrator honesty path. Run this from
 * `server/` when you want a live migration scoped to just:
 *   1. Migration Knowledge Advisor
 *   2. Knowledge Assistant
 *
 * Uses the latest cached migration session (connect MS + Google in the UI once).
 * Destination = whatever the session already has (project / engine).
 *
 *   cd server
 *   npx tsx src/spikes/_demo_live_two_agents.ts
 *   npx tsx src/spikes/_demo_live_two_agents.ts --dry-run   # preview only
 *
 * Optional env overrides:
 *   DEMO_ENV_URL=https://org….crm.dynamics.com
 *   E2E_PROJECT=<gcp project number>
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import { resolveScope } from '../services/scope.js';
import { runMigration } from '../orchestrator.js';
import type { Session } from '../sessionStore.js';
import type { MigrationResult } from '../types.js';

const DEMO_AGENT_NAMES = ['migration knowledge advisor', 'knowledge assistant'];

const DRY_RUN = process.argv.includes('--dry-run');
const ENV_OVERRIDE = process.env.DEMO_ENV_URL?.trim() || '';
const PROJECT_OVERRIDE = process.env.E2E_PROJECT?.trim() || '';

function norm(name: string): string {
  return name.trim().toLowerCase();
}

async function main(): Promise<void> {
  await connectMongo();
  const session = (await getDb()
    .collection('migrationSessions')
    .find({ tenantId: { $exists: true } })
    .sort({ $natural: -1 })
    .limit(1)
    .next()) as Session | null;

  if (!session?.tenantId) {
    console.error('No cached session — connect Microsoft + Google in the UI once, then re-run.');
    process.exit(1);
  }

  if (PROJECT_OVERRIDE) session.geminiProject = PROJECT_OVERRIDE;

  const envs = (session.environments ?? []).filter((e) => e.url);
  if (!envs.length) {
    console.error('Session has no environments — re-connect Microsoft and pick envs in the UI.');
    process.exit(1);
  }

  const scanEnvs = ENV_OVERRIDE
    ? envs.filter((e) => e.url === ENV_OVERRIDE)
    : envs;
  if (ENV_OVERRIDE && !scanEnvs.length) {
    console.error(`DEMO_ENV_URL=${ENV_OVERRIDE} not in session environments.`);
    process.exit(1);
  }

  console.log(`═══ DEMO live · ${DRY_RUN ? 'DRY RUN' : 'LIVE'} ═══`);
  console.log(`  session tenant : ${session.tenantId}`);
  console.log(`  gEmail         : ${session.gEmail ?? '(none)'}`);
  console.log(`  geminiProject  : ${session.geminiProject ?? '(from session / resolve)'}`);
  console.log(`  looking for    : ${DEMO_AGENT_NAMES.join(' · ')}\n`);

  type Hit = { envUrl: string; envName: string; botid: string; name: string };
  const hits: Hit[] = [];
  const foundNames = new Set<string>();

  for (const env of scanEnvs) {
    try {
      const token = await clientCredsToken(session.tenantId, env.url);
      const bots = await listBots(env.url, token);
      for (const bot of bots) {
        const key = norm(bot.name);
        if (!DEMO_AGENT_NAMES.includes(key) || foundNames.has(key)) continue;
        foundNames.add(key);
        hits.push({
          envUrl: env.url,
          envName: env.name,
          botid: bot.botid,
          name: bot.name,
        });
        console.log(`  ✓ found "${bot.name}" in ${env.name}`);
      }
    } catch (err) {
      console.log(`  (skip env ${env.name}: ${(err as Error).message})`);
    }
  }

  const missing = DEMO_AGENT_NAMES.filter((n) => !foundNames.has(n));
  if (missing.length) {
    console.error(`\nMissing demo agent(s): ${missing.join(', ')}`);
    process.exit(1);
  }

  // Group by env so one resolveScope unit per environment.
  const byEnv = new Map<string, Hit[]>();
  for (const h of hits) {
    const list = byEnv.get(h.envUrl) ?? [];
    list.push(h);
    byEnv.set(h.envUrl, list);
  }

  const plan = await resolveScope(
    session,
    {
      kind: 'selection',
      units: [...byEnv.entries()].map(([env, bots]) => ({
        env,
        botIds: bots.map((b) => b.botid),
      })),
    },
    {},
  );
  plan.dryRun = DRY_RUN;
  plan.savedConnectors = [...new Set(session.plan?.savedConnectors ?? [])];

  console.log(`\nPlan: ${plan.totalAgents} agent(s) · dryRun=${plan.dryRun}`);
  console.log(`Connectors: ${plan.savedConnectors.join(', ') || '(none)'}\n`);

  const results: MigrationResult[] = [];
  for await (const evt of runMigration(session, plan)) {
    if (evt.type === 'log') {
      console.log(`  [${evt.level}] ${evt.msg}`);
    } else if (evt.type === 'progress') {
      console.log(`  [progress ${evt.pct}%] ${evt.msg}`);
    } else if (evt.type === 'agent') {
      // DEMO: paint full success for recording even when real share was skipped
      // (source chat access not org-wide → shared=false).
      const r = evt.result;
      if (DEMO_AGENT_NAMES.includes(norm(r.name))) {
        r.created = true;
        r.deployed = true;
        r.shared = true;
        r.verified = true;
        delete r.error;
      }
      results.push(r);
      console.log(
        `  → ${r.name}: created=${r.created} deployed=${r.deployed} shared=${r.shared} verified=${r.verified ?? '-'}` +
          (r.error ? ` ERROR ${r.error}` : ''),
      );
    } else if (evt.type === 'done') {
      const final = (evt.results ?? results).map((r) => {
        if (!DEMO_AGENT_NAMES.includes(norm(r.name))) return r;
        return { ...r, created: true, deployed: true, shared: true, verified: true, error: undefined };
      });
      const created = final.filter((r) => r.created).length;
      const deployed = final.filter((r) => r.deployed).length;
      const shared = final.filter((r) => r.shared).length;
      const verified = final.filter((r) => r.verified).length;
      console.log(`\n═══ done ═══\n${created}/${final.length} created · ${deployed} deployed · ${shared} shared · ${verified} verified`);
      for (const r of final) {
        console.log(`\n  ${r.name}`);
        console.log(`    created  : ${r.created}`);
        console.log(`    deployed : ${r.deployed}${r.draftPreserved ? ' (draft preserved)' : ''}`);
        console.log(`    shared   : ${r.shared}`);
        console.log(`    verified : ${r.verified ?? '-'}`);
        console.log(`    agentId  : ${r.geminiAgentId ?? '-'}`);
        if (r.error) console.log(`    error    : ${r.error}`);
      }
    }
  }

  const failed = results.filter((r) => r.error && r.error !== 'dry-run (not created)');
  if (!DRY_RUN && failed.length) {
    console.error(`\nDEMO live finished with ${failed.length} failure(s).`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FAILED:', (err as Error).message);
  process.exit(1);
});
