/** What happened on the most recent run? Read the DB, not the log — the log file was truncated
 *  by a duplicate server start and its tail is no longer trustworthy. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const runs = (await db.collection('migrationRuns').find({}).sort({ _id: -1 }).limit(2).toArray()) as Array<Record<string, any>>;
for (const r of runs) {
  console.log(`run ${String(r.runId ?? r._id)}  started=${String(r.startedAt ?? r.createdAt ?? '?')}  status=${String(r.status ?? '?')}  agents=${r.totalAgents ?? '?'}`);
}
const res = (await db.collection('migrationResults').find({}).sort({ _id: -1 }).limit(4).toArray()) as Array<Record<string, any>>;
console.log('\nnewest results:');
for (const r of res) {
  console.log(`  ${String(r.name).padEnd(30)} deployed=${r.deployed} shared=${r.shared} verified=${r.verified} agentId=${r.geminiAgentId ?? '-'} err=${r.error ?? '-'}`);
  console.log(`     updatedAt=${String(r.updatedAt ?? '?')} verifyStatus=${r.verifyStatus ?? '-'}`);
}
process.exit(0);
