import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const run = await getDb().collection('migrationRuns').find({}).sort({ startTime: -1 }).limit(1).next();
  console.log('RUN:', run?._id, run?.status, run?.startTime);
  const results = await getDb().collection('migrationResults').find({ runId: run?._id }).toArray();
  for (const r of results) {
    console.log('\n===', r.name, '===');
    console.log('created:', r.created, 'deployed:', r.deployed, 'shared:', r.shared, 'verified:', r.verified);
    for (const f of r.fidelity ?? []) {
      console.log(`  [${f.status}] ${f.component}: ${f.detail?.slice(0, 200)}`);
    }
  }
}
main().catch((e) => console.error('FAILED:', e.message));
