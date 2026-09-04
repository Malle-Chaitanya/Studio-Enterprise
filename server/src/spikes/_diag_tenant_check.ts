import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('environmentsCache').find({}).sort({ $natural: -1 }).limit(5).toArray();
for (const r of rows as any[]) {
  console.log(JSON.stringify({ tenantId: r.tenantId, envCount: r.environments?.length, id: String(r._id) }, null, 2));
}
process.exit(0);
