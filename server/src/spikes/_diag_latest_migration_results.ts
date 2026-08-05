import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';

async function main() {
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  const runs = await db.collection('migrationRuns').find({}).sort({ startTime: -1 }).limit(3).toArray();
  for (const run of runs as any[]) {
    console.log('='.repeat(80));
    console.log('runId:', run._id, 'startTime:', run.startTime, 'status:', run.status, 'totalAgents:', run.totalAgents);
    const results = await db.collection('migrationResults').find({ runId: run._id }).toArray();
    for (const r of results as any[]) {
      console.log('-'.repeat(60));
      console.log('name:', r.name, '| created:', r.created, '| deployed:', r.deployed, '| geminiAgentId:', r.geminiAgentId, '| error:', r.error);
      for (const f of r.fidelity || []) {
        console.log(`   [${f.status}] ${f.component}: ${f.detail}`);
      }
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
