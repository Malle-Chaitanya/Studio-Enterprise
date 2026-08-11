import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const logs = await getDb().collection('migrationLogs').find({
    msg: { $regex: /429|RESOURCE_EXHAUSTED|quota exceeded|quota exhausted/i },
  }).sort({ $natural: -1 }).limit(10).toArray();
  console.log('Quota-related log entries found:', logs.length);
  for (const l of logs) console.log(l.ts, '|', l.level, '|', l.msg?.slice(0, 200));
}
main().catch((e) => console.error('FAILED:', e.message));
