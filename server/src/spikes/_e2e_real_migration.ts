/**
 * A REAL migration through the product path — not a spike reimplementation.
 *
 * Calls resolveScope() then runMigration() exactly as `GET /api/migrate/stream` does, so
 * what this exercises is the orchestrator customers actually run: SharePoint indexing via
 * Graph, per-agent tool scoping, topics as sub-agents, ADK deploy, share, verify, report.
 *
 * Uses the cached session (its Google/Microsoft tokens and its chosen destination), so the
 * destination is whatever was picked in the UI. Pass a target project to override when the
 * session points somewhere our service account has no rights — e.g. the GTM project, where
 * Secret Manager and GCS both refuse us.
 *
 * Costs one agent-creation unit per agent migrated (quota ~7/day).
 *
 *   npx tsx src/spikes/_e2e_real_migration.ts "<agent name>" [envUrl] [geminiProject]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import { resolveScope } from '../services/scope.js';
import { runMigration } from '../orchestrator.js';
import type { Session } from '../sessionStore.js';

const AGENT_NAME = process.argv[2] ?? 'CloudFuze Studio Migrate';
const ENV_URL = process.argv[3] ?? 'https://orga243378d.crm.dynamics.com';
const PROJECT_OVERRIDE = process.argv[4] ?? process.env.E2E_PROJECT ?? '';

await connectMongo();
const session = (await getDb()
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;
if (!session) { console.error('no cached session — connect Microsoft + Google in the UI once'); process.exit(1); }

// The session carries the destination chosen in the wizard. Override it when that project
// is one our SA cannot write to, so the run tests the pipeline rather than IAM.
if (PROJECT_OVERRIDE) session.geminiProject = PROJECT_OVERRIDE;

const dvToken = await clientCredsToken(session.tenantId!, ENV_URL);
const bot = (await listBots(ENV_URL, dvToken)).find((b) => b.name === AGENT_NAME);
if (!bot) { console.error(`agent "${AGENT_NAME}" not found in ${ENV_URL}`); process.exit(1); }

console.log(`═══ migrating "${bot.name}" ═══`);
console.log(`  env     : ${ENV_URL}`);
console.log(`  project : ${(session as unknown as { geminiProject?: string }).geminiProject ?? '(from session)'}`);
console.log(`  savedConnectors: ${JSON.stringify(session.plan?.savedConnectors ?? [])}\n`);

const plan = await resolveScope(
  session,
  { kind: 'agents', env: ENV_URL, botIds: [bot.botid] },
  { prefixWithEnv: false },
);
// Carry over connector credentials the customer saved in the UI — the orchestrator reads
// these to decide which live tools to wire.
// Connectors the customer configured. E2E_CONNECTORS lets a test name them explicitly
// when the cached session predates the credential save.
const extra = (process.env.E2E_CONNECTORS ?? '').split(',').map((x) => x.trim()).filter(Boolean);
plan.savedConnectors = [...new Set([...(session.plan?.savedConnectors ?? []), ...extra])];
console.log(`connectors wired: ${plan.savedConnectors.join(', ') || '(none)'}`);
console.log(`plan: ${plan.totalAgents} agent(s)\n`);

let done = false;
for await (const evt of runMigration(session, plan)) {
  if (evt.type === 'log') {
    console.log(`  [${evt.level}] ${evt.msg}`);
  } else if (evt.type === 'agent') {
    const r = evt.result;
    console.log(`  → ${r.name}: created=${r.created} deployed=${r.deployed} shared=${r.shared} verified=${r.verified ?? '-'}${r.error ? ` ERROR ${r.error}` : ''}`);
  } else if (evt.type === 'done') {
    done = true;
    console.log(`\n═══ done ═══\n${evt.summary}`);
    for (const r of evt.results ?? []) {
      console.log(`\n  ${r.name}`);
      console.log(`    created  : ${r.created}  deployed=${r.deployed}  agentId=${r.geminiAgentId ?? '-'}`);
      console.log(`    shared   : ${r.shared}   verified: ${r.verified ?? '-'}`);
      if (r.error) console.log(`    ERROR    : ${r.error}`);
      const notes = r.fidelity ?? [];
      const bad = notes.filter((n) => n.status === 'lost' || n.status === 'needs-review');
      console.log(`    fidelity : ${notes.length} note(s), ${bad.length} need attention`);
      for (const n of bad.slice(0, 6)) console.log(`       [${n.status}] ${n.component}: ${n.detail.slice(0, 150)}`);
    }
  }
}
if (!done) console.log('\n(stream ended without a done event)');
process.exit(0);
