/**
 * Drive a real migration through the ORCHESTRATOR — the same code path the UI calls.
 *
 * The existing `_e2e_*` spikes call `publishAgentToGallery` directly, which proves the tools
 * work but skips everything the orchestrator does around them: scope resolution, staging,
 * the surface decision, connector scoping, the pre-flight gate, verification and the report.
 * A migration that works in those spikes and fails from the UI is exactly the gap this
 * closes, so this one goes through `runMigration` and touches nothing underneath it.
 *
 * The only thing it does that a browser would not is RECORD THE SURFACE DECISION first —
 * that is a click on the Connectors screen, and there is no way to click from here. Everything
 * after that is byte-for-byte the UI's path.
 *
 *   cd server && npx tsx src/spikes/_e2e_ui_migration.ts <agent-name-substring> <target>
 *
 *   target:  shared_teams        keep Teams (read-only)
 *            shared_googlechat   move messaging to Google Chat
 *            skip                migrate with no tools for that surface
 *
 * Prints the orchestrator's own event stream, so what appears here is what the customer
 * would have seen in the browser.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { runMigration } from '../orchestrator.js';
import { saveAgentSurfaceChoice, SURFACE_EQUIVALENTS } from '../db/repos/agentSurfaceChoice.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { agentConnectorIds } from '../services/connectorToolBuilder.js';
import type { Session, ResolvedPlan } from '../types.js';

const NAME = (process.argv[2] || 'Teams Coordinator').toLowerCase();
const TARGET = process.argv[3] || 'shared_googlechat';
const IMPERSONATE = process.argv[4] || 'zara@storefuze.com';

await connectMongo();
const db = getDb();

const session = (await db
  .collection('migrationSessions')
  .find({})
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as unknown as (Session & { _id: string; plan?: ResolvedPlan }) | null;
if (!session) { console.log('no session in the DB — sign in through the UI once first'); process.exit(1); }

const appUserId = session.appUserId!;
const plan = session.plan;
if (!plan?.units?.length) { console.log('session has no plan — walk to the Migrate step once'); process.exit(1); }

// Find the agent by name across the plan, so the caller does not have to know its guid.
let found: { envUrl: string; botid: string; name: string } | undefined;
for (const u of plan.units) {
  for (const b of u.bots ?? []) {
    if ((b.name ?? '').toLowerCase().includes(NAME)) found = { envUrl: u.envUrl, botid: b.botid, name: b.name ?? '' };
  }
}
if (!found) {
  console.log(`no planned agent matching "${NAME}". Planned agents:`);
  for (const u of plan.units) for (const b of u.bots ?? []) console.log(`   ${b.name} (${b.botid})`);
  process.exit(1);
}
console.log(`agent   : ${found.name}  ${found.botid}`);
console.log(`env     : ${found.envUrl}`);

// Which cross-vendor surface does this agent actually use? Asked rather than assumed: the
// whole point of the generic path is that it works for a connector mix nobody predicted.
const cached = await getCachedIR(appUserId, found.envUrl, found.botid);
if (!cached) { console.log('no cached IR — open the Connectors step once so it is extracted'); process.exit(1); }
const connectorIds = agentConnectorIds(cached.ir);
const surfaces = Object.keys(SURFACE_EQUIVALENTS).filter((k) => connectorIds.has(k));
console.log(`connectors: ${[...connectorIds].join(', ') || '(none)'}`);
console.log(`surfaces  : ${surfaces.join(', ') || '(none — nothing to decide)'}`);

for (const sourceConnectorId of surfaces) {
  const eq = SURFACE_EQUIVALENTS[sourceConnectorId];
  const valid = TARGET === 'skip' || eq.targets.some((t) => t.connectorId === TARGET);
  if (!valid) {
    console.log(`\n"${TARGET}" is not offered for ${sourceConnectorId}. Offered:`);
    for (const t of eq.targets) console.log(`   ${t.connectorId}  ${t.name}`);
    process.exit(1);
  }
  await saveAgentSurfaceChoice({
    appUserId,
    sourceId: found.botid,
    sourceConnectorId,
    decision: TARGET === 'skip' ? 'skip' : TARGET,
    targetConnectorId: TARGET === 'skip' ? undefined : TARGET,
    impersonateEmail: TARGET === 'skip' ? undefined : IMPERSONATE,
  } as Parameters<typeof saveAgentSurfaceChoice>[0]);
  const chosen = eq.targets.find((t) => t.connectorId === TARGET);
  console.log(`decision  : ${sourceConnectorId} -> ${chosen?.name ?? 'skip'}${TARGET === 'skip' ? '' : ` (${IMPERSONATE})`}`);
}

// Narrow the plan to this ONE agent. Migrating the whole plan would redeploy siblings and
// muddy which run produced which engine.
const scopedPlan: ResolvedPlan = {
  ...plan,
  units: [{ ...plan.units.find((u) => u.envUrl === found!.envUrl)!, bots: [{ botid: found.botid, name: found.name } as never] }],
  totalAgents: 1,
  // Without this the second run of the same agent is skipped as "already exists" and proves
  // nothing. This is the flag the web client still does not send.
  forceRedeploy: true,
};

console.log(`\n--- runMigration (forceRedeploy=true) ---`);
let doneSummary = '';
const results: unknown[] = [];
for await (const evt of runMigration(session as Session, scopedPlan)) {
  if (evt.type === 'log') {
    const level = evt.level === 'fail' ? 'FAIL' : evt.level === 'warn' ? 'WARN' : '    ';
    console.log(`${level} ${evt.msg}`);
  } else if (evt.type === 'progress') {
    console.log(`     [${evt.stage}] ${evt.done}/${evt.total}`);
  } else if (evt.type === 'done') {
    doneSummary = evt.summary;
    results.push(...(evt.results ?? []));
  }
}

console.log(`\n--- RESULT ---`);
console.log(doneSummary);
for (const r of results as Array<Record<string, unknown>>) {
  console.log(`\n${String(r.name)}`);
  console.log(`  created=${r.created} deployed=${r.deployed} shared=${r.shared} verified=${r.verified}`);
  console.log(`  agentId=${String(r.geminiAgentId ?? '-')}  error=${String(r.error ?? '-')}`);
  const fid = (r.fidelity ?? []) as Array<{ component: string; status: string; detail: string }>;
  // The connector and surface notes are the ones that decide whether this migration kept the
  // agent's behaviour, so they are printed in full rather than counted.
  for (const f of fid.filter((x) => /connector|surface|adk|verif/i.test(x.component))) {
    console.log(`  [${f.status}] ${f.component}: ${f.detail.slice(0, 260)}`);
  }
}
process.exit(0);
