/**
 * What did the most recent run actually produce, per agent?
 *
 * The dev-server log is overwritten on every restart, so it cannot answer "what happened on
 * that run" an hour later. `migrationResults` can, and it is the record the report is built
 * from — so it is also the thing that must be honest.
 *
 *   cd server && npx tsx src/spikes/_diag_last_run_results.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();

const runs = await db.collection('migrationRuns').find({}).sort({ $natural: -1 }).limit(3).toArray();
for (const r of runs) {
  const run = r as Record<string, unknown>;
  console.log(`\n=== run ${String(run.runId)} ===`);
  console.log(`   started ${String(run.startedAt ?? '?')}  finished ${String(run.finishedAt ?? '(never)')}`);
  console.log(`   status  ${String(run.status ?? '?')}`);

  const results = await db.collection('migrationResults')
    .find({ runId: run.runId }).toArray();
  for (const x of results) {
    const m = x as Record<string, unknown>;
    console.log(`   - ${String(m.sourceName ?? m.name ?? '?')}`);
    console.log(`       status    ${String(m.status ?? '?')}`);
    console.log(`       engine    ${String(m.reasoningEngine ?? m.engineId ?? '-')}`);
    console.log(`       verified  ${JSON.stringify(m.verified ?? null)}`);
    const notes = (m.fidelityNotes ?? []) as Array<{ severity?: string; message?: string }>;
    for (const n of notes.filter((n) => n.severity === 'lost' || n.severity === 'needs-review')) {
      console.log(`       ${n.severity}: ${String(n.message).slice(0, 140)}`);
    }
  }
}
process.exit(0);
