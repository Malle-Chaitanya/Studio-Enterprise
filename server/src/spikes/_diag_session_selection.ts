import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const s = await getDb().collection('migrationSessions').find({}).limit(3).toArray();
for (const x of s as any[]) {
  console.log(`\nsession ${x._id} keys=${Object.keys(x).join(',')}`);
  console.log('plan=', JSON.stringify(x.plan)?.slice(0, 1200));
}
process.exit(0);
