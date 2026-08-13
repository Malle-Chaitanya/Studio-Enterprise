import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
for (const c of ['stagedAgents', 'agentIRCache']) {
  const n = await db.collection(c).countDocuments();
  const one = await db.collection(c).findOne({});
  console.log(c, n, one ? Object.keys(one).join(',') : '(none)');
}
process.exit(0);
