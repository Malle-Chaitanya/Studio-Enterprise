/**
 * What did the most recent UI run actually record?
 *
 * The dev server logs to its own terminal, so a run started from the browser is invisible
 * from here. Mongo is not: sessions, surface decisions, runs and per-agent results are all
 * persisted, and they say more than a log tail would.
 *
 *   cd server && npx tsx src/spikes/_diag_recent_run.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();
const ago = (d?: Date | string) => {
  if (!d) return '?';
  const ms = Date.now() - new Date(d).getTime();
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`;
};

for (const coll of ['migrationSessions', 'agentSurfaceChoice', 'migrationRuns', 'migrationResults']) {
  const n = await db.collection(coll).countDocuments();
  console.log(`\n=== ${coll} (${n}) ===`);
  const rows = await db.collection(coll).find({}).sort({ $natural: -1 }).limit(5).toArray();
  for (const r of rows) {
    if (coll === 'agentSurfaceChoice') {
      console.log(`  ${ago(r.updatedAt ?? r.createdAt)}  ${r.sourceConnectorId} -> ${r.decision}` +
        `${r.impersonateEmail ? ` as ${r.impersonateEmail}` : ''}  agent=${String(r.sourceId).slice(0, 8)}`);
    } else if (coll === 'migrationRuns') {
      console.log(`  ${ago(r.startedAt ?? r.createdAt)}  status=${r.status} agents=${r.totalAgents ?? '?'} ok=${r.succeeded ?? '?'} failed=${r.failed ?? '?'}`);
    } else if (coll === 'migrationResults') {
      const f = (r.fidelity ?? []) as Array<{ component?: string; status?: string; detail?: string }>;
      console.log(`  ${ago(r.completedAt ?? r.createdAt)}  "${r.name}" status=${r.status} verified=${JSON.stringify(r.verified)?.slice(0, 60)}`);
      for (const x of f.filter((y) => y.component?.startsWith('surface:') || y.status !== 'ok').slice(0, 6)) {
        console.log(`      [${x.status}] ${x.component}: ${String(x.detail).slice(0, 130)}`);
      }
    } else {
      console.log(`  ${ago(r.updatedAt ?? r.createdAt)}  gEmail=${r.gEmail ?? '-'} tenant=${r.tenantId ? 'set' : '-'} env=${String(r.envUrl ?? '-').slice(0, 40)}`);
    }
  }
}
process.exit(0);
