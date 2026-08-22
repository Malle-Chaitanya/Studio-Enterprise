/** What project/engine did the last real run write to? Needed to ask the destination what
 *  already exists before a re-run, instead of guessing an engine id (which the rules forbid).
 *   cd server && npx tsx src/spikes/_diag_last_destination.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
for (const coll of ['migrationRuns', 'migrationResults', 'migrationSessions']) {
  const rows = await db.collection(coll).find({}).sort({ _id: -1 }).limit(3).toArray();
  console.log(`\n=== ${coll} (${await db.collection(coll).countDocuments()} docs) ===`);
  for (const r of rows as Array<Record<string, unknown>>) {
    const d = (r.destination ?? r.dest ?? {}) as Record<string, unknown>;
    console.log(`  ${String(r.createdAt ?? r.startedAt ?? '')}  project=${String(d.projectId ?? r.projectId ?? '?')} engine=${String(d.engineId ?? r.engineId ?? '?')} appUserId=${String(r.appUserId ?? '?')}`);
  }
}
process.exit(0);
