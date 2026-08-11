import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const run = await getDb().collection('migrationRuns').find({}).sort({ $natural: -1 }).limit(1).next();
  console.log('LATEST RUN:', JSON.stringify(run, null, 2));
  if (run) {
    const results = await getDb().collection('migrationResults').find({ runId: run.runId ?? run._id }).toArray();
    console.log('\nRESULTS:', results.length);
    for (const r of results) {
      console.log('---', r.name, '---');
      console.log('created:', r.created, 'deployed:', r.deployed, 'verified:', r.verified, 'error:', r.error);
      console.log('fidelity:', JSON.stringify(r.fidelity, null, 2));
    }
  }
}
main().catch((e) => console.error('FAILED:', e.message));
