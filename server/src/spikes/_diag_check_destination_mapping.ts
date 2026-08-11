import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const runs = await getDb().collection('migrationRuns').find({ _id: { $in: ['TOWMsrR6bT58Tl6mxSYXp59fw1w', 'uPsLMbHSwPZCucGqHfOAKWBh5P4'] } }).toArray();
  for (const r of runs) {
    console.log('=== run', r._id, '===');
    console.log('destination:', JSON.stringify(r.destination ?? r.plan?.destination, null, 2));
    console.log('bots:', JSON.stringify(r.plan?.units?.map((u: any) => ({ envUrl: u.envUrl, envName: u.envName, bots: u.bots?.map((b: any) => b.name) })), null, 2));
  }
}
main().catch((e) => console.error('FAILED:', e.message));
