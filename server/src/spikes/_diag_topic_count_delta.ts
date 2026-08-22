/** Does the raw componenttype-9 count match what staging reports as "topics"? */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('stagedAgents')
  .find({ displayName: { $in: ['Knowledge Assistant', 'WorkMate', 'Confluence Knowledge Assistant'] } })
  .sort({ _id: -1 }).limit(6).toArray() as any[];
const seen = new Set<string>();
for (const r of rows) {
  if (seen.has(r.displayName)) continue;
  seen.add(r.displayName);
  console.log(`${r.displayName}: staged topicCount=${r.topicCount} knowledgeCount=${r.knowledgeCount}`);
}
process.exit(0);
