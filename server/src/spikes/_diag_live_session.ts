/** Is there a usable session right now, and what does it carry? A session is the only thing
 *  that holds the customer's tokens, so driving a migration from a script depends entirely on
 *  one existing — and it has a TTL, so "there was one an hour ago" is not an answer. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = (await getDb().collection('migrationSessions').find({}).sort({ _id: -1 }).toArray()) as Array<Record<string, any>>;
console.log(`${rows.length} session(s)`);
for (const r of rows) {
  console.log(`\nid=${String(r.sessionId ?? r._id)}  appUserId=${String(r.appUserId)}  updated=${String(r.updatedAt ?? r.createdAt ?? '?')}`);
  console.log(`  fields: ${Object.keys(r).join(', ')}`);
  console.log(`  hasPlan=${!!r.plan}  planAgents=${(r.plan?.agents ?? r.plan?.bots ?? []).length ?? 0}`);
  console.log(`  msToken=${r.msToken || r.microsoft ? 'present' : 'absent'}  googleToken=${r.googleToken || r.google ? 'present' : 'absent'}`);
}
process.exit(0);
