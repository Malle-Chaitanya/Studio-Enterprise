/** Get the reasoning engine / agent id for the most recent successful "AA" deployment,
 *  so we can send it a real query and see whether the Drive tool actually fires.
 *  npx tsx src/spikes/_diag_get_latest_deployment.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const dep = await getDb()
    .collection('adkDeployments')
    .find({})
    .sort({ $natural: -1 })
    .limit(3)
    .toArray();
  console.log('--- adkDeployments (latest 3) ---');
  for (const d of dep) console.log(JSON.stringify(d, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
