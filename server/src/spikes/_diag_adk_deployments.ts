/** What does our own deployment record say for these agents? Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('adkDeployments').find({}).toArray();
for (const r of rows as any[]) {
  console.log(`${(r.displayName ?? r.sourceId ?? '?').padEnd(34)} agentId=${r.agentId ?? '-'} engine=${String(r.reasoningEngine ?? '').split('/').pop()} updated=${r.updatedAt ?? r.createdAt ?? '-'}`);
}
process.exit(0);
