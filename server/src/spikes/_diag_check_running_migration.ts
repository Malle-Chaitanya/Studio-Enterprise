import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const running = await getDb().collection('migrationRuns').find({ status: { $in: ['running', 'in-progress'] } }).sort({ startTime: -1 }).limit(3).toArray();
  console.log('RUNNING/IN-PROGRESS RUNS:', running.length);
  for (const r of running) console.log(r._id, r.status, r.startTime, r.totalAgents);

  const allRecent = await getDb().collection('migrationRuns').find({}).sort({ startTime: -1 }).limit(5).toArray();
  console.log('\nMOST RECENT RUNS BY startTime:');
  for (const r of allRecent) console.log(r._id, r.status, r.startTime, r.summary);
}
main().catch((e) => console.error('FAILED:', e.message));
