import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('migratedAgentSnapshots').find({}).toArray().catch(() => []);
console.log(`migratedSnapshot rows: ${rows.length}`);
for (const r of rows as any[]) console.log(`  sourceId=${r.sourceId} project=${r.project} engine=${(r.engine ?? '').slice(0, 40)}`);
process.exit(0);
