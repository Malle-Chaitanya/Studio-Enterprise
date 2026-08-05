import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const cols = ['migrationResults', 'migrationRuns', 'stagedAgents'];
  for (const c of cols) {
    const n = await getDb().collection(c).countDocuments({});
    console.log(c, 'count=', n);
  }
  const r = await getDb().collection('migrationResults').find({}).sort({ $natural: -1 }).limit(5).toArray();
  console.log('SAMPLE:', JSON.stringify(r, null, 2).slice(0, 3000));
  process.exit(0);
}
main().catch((e) => {
  console.error('ERR', e.message);
  process.exit(1);
});
