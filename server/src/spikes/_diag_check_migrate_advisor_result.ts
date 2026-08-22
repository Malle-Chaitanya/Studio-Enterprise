import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const result = await getDb().collection('migrationResults')
    .find({ name: /migrate advisor/i })
    .sort({ $natural: -1 })
    .limit(1)
    .next();
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
