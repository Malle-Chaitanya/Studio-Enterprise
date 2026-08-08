import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
async function main() {
  await connectMongo();
  const results = await getDb().collection('migrationResults').find({ runId: 'dV7RjoyrfIPBEW-qDNTlFIrwlIc' }).toArray();
  for (const r of results) {
    console.log('\n===', r.name, '===');
    console.log('created:', r.created, 'deployed:', r.deployed, 'verified:', r.verified);
    for (const f of r.fidelity ?? []) {
      if (f.component.startsWith('knowledge:')) console.log(`  [${f.status}] ${f.component}: ${f.detail?.slice(0, 250)}`);
    }
  }
}
main().catch((e) => console.error('FAILED:', e.message));
