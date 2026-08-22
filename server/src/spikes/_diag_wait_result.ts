/** Wait for one agent's result row to land, reading the DB rather than a log file another
 *  process owns (a duplicate server start truncated the log once already). */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
const [sourceId, sinceIso] = process.argv.slice(2);
const since = new Date(sinceIso).getTime();
await connectMongo();
const db = getDb();
for (let i = 0; i < 60; i++) {
  const r = (await db.collection('migrationResults').findOne({ sourceId }, { sort: { _id: -1 } })) as Record<string, any> | null;
  const at = r?.updatedAt ? new Date(r.updatedAt).getTime() : 0;
  if (r && at >= since) {
    console.log(`RESULT ${r.name}: deployed=${r.deployed} shared=${r.shared} verified=${r.verified} verifyStatus=${r.verifyStatus ?? '-'} agentId=${r.geminiAgentId ?? '-'} err=${r.error ?? '-'}`);
    process.exit(0);
  }
  await new Promise((res) => setTimeout(res, 20_000));
}
console.log('no result after 20 minutes');
process.exit(0);
