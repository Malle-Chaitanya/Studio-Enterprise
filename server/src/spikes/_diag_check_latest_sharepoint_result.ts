import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const logs = await getDb().collection('migrationLogs').find({
    msg: { $regex: /TestingPermissions|daily_queries|copy mode|copy-mode/i },
  }).sort({ $natural: -1 }).limit(10).toArray();
  console.log('Recent SharePoint/copy-mode log entries:');
  for (const l of logs) console.log(l.ts, '|', l.level, '|', l.msg?.slice(0, 300));
}
main().catch((e) => console.error('FAILED:', e.message));
