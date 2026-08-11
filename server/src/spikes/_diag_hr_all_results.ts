import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

const SOURCE_ID = 'ad009852-cea1-436f-849d-5079a93fd5b4';

async function main() {
  await connectMongo();
  const db = getDb();
  const all = await db.collection('migrationResults').find({ sourceId: SOURCE_ID }).sort({ updatedAt: -1 }).toArray();
  console.log(`found ${all.length} migrationResults doc(s) for this sourceId`);
  for (const r of all as any[]) {
    console.log(`\nrunId=${r.runId} updatedAt=${r.updatedAt} created=${r.created} deployed=${r.deployed}`);
    for (const f of r.fidelity ?? []) {
      if (String(f.component).startsWith('knowledge:')) console.log(`  ${f.component} -> ${f.status}: ${f.detail}`);
    }
  }
  const runs = await db.collection('migrationRuns').find({}).sort({ startTime: -1 }).limit(5).toArray();
  console.log('\nrecent migrationRuns:');
  for (const r of runs as any[]) console.log(`  ${r._id} startTime=${r.startTime}`);
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
