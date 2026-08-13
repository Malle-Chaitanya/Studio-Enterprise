import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const runs = await db.collection('migrationRuns').find<any>({}).sort({ _id: -1 }).limit(2).toArray();
for (const r of runs) {
  console.log(`\nrun ${r.runId ?? r._id} status=${r.status ?? '?'} started=${r.startedAt?.toISOString?.() ?? '?'} finished=${r.finishedAt?.toISOString?.() ?? '(none)'} total=${r.totalAgents ?? '?'} created=${r.created ?? '?'}`);
}
const res = await db.collection('migrationResults').find<any>({}).sort({ _id: -1 }).limit(5).toArray();
for (const x of res) {
  console.log(`result: ${x.name ?? x.sourceName ?? '?'} created=${x.created} agentId=${x.agentId ?? '-'} verified=${x.verified} error=${x.error ?? '-'} at=${x.completedAt?.toISOString?.() ?? x.migratedAt?.toISOString?.() ?? '?'}`);
}
process.exit(0);
