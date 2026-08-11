import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const logs = await getDb().collection('migrationLogs').find({}).sort({ $natural: -1 }).limit(15).toArray();
  console.log('MOST RECENT LOG ENTRIES:');
  for (const l of logs) console.log(JSON.stringify(l).slice(0, 300));
}
main().catch((e) => console.error('FAILED:', e.message));
