/** Real end-to-end test: run the actual orchestrator's runMigration() against the real
 *  "Deal Desk" agent with its Dataverse surface explicitly set to "Use Cloud SQL" (the
 *  per-agent choice — see db/repos/agentSurfaceChoice.ts's shared_commondataserviceforapps
 *  entry — that REPLACED the old run-level dataverseCutoverMode flag this script used to
 *  set directly). Uses the same session already set up (connectors saved, destination
 *  chosen) from the manual testing earlier this session. Streams every real progress event
 *  to the console.
 *  npx tsx src/spikes/_diag_run_real_cloudsql_migration.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSession, DEFAULT_APP_USER_ID } from '../sessionStore.js';
import { runMigration } from '../orchestrator.js';
import { saveAgentSurfaceChoice } from '../db/repos/agentSurfaceChoice.js';
import type { Session } from '../sessionStore.js';
import type { ResolvedPlan } from '../types.js';

await connectMongo();
const db = getDb('csge');

// Find the most recent real session with a Google project + Dataverse connection already
// set up (same one used for the manual Deal Desk redeploy tests earlier).
const raw = await db
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true }, dvOrgUrl: { $exists: true }, geminiProject: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next();
if (!raw?._id) throw new Error('NO_USABLE_SESSION');
const sessionId = String(raw._id);
console.log('Using session:', sessionId, 'project:', (raw as any).geminiProject);

const session = await getSession(sessionId);
if (!session) throw new Error('SESSION_NOT_FOUND_VIA_getSession');

const plan = (session as Session & { plan?: ResolvedPlan }).plan;
if (!plan) throw new Error('SESSION_HAS_NO_STORED_PLAN — run /plan once via the app first');

console.log('Agents in plan:', plan.units.flatMap((u) => u.bots?.map((b) => b.name) ?? []));

const dealDesk = plan.units.flatMap((u) => u.bots ?? []).find((b) => b.name === 'Deal Desk');
if (!dealDesk) throw new Error('DEAL_DESK_NOT_IN_PLAN');
const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
await saveAgentSurfaceChoice({
  appUserId,
  sourceId: dealDesk.botid,
  sourceConnectorId: 'shared_commondataserviceforapps',
  decision: 'cloudsql',
  targetConnectorId: 'cloudsql',
  decidedBy: 'diag-script',
});
console.log('Recorded surface choice: Deal Desk -> Use Cloud SQL (shared_commondataserviceforapps)');

plan.dryRun = false;
plan.forceRedeploy = true; // otherwise drift detection short-circuits with "already exists — skipped"
// and the Cloud SQL block never runs at all — exactly what happened on the first attempt.

console.log('\n=== Running real migration, Deal Desk Dataverse -> Use Cloud SQL ===\n');
for await (const event of runMigration(session, plan)) {
  console.log(JSON.stringify(event).slice(0, 500));
}
console.log('\n=== DONE ===');
process.exit(0);
