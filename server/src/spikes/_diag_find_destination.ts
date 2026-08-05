import { connectDb, getDb } from '../db/core.js';
import { config } from '../config.js';

async function main() {
  const nameQuery = process.argv[2];
  await connectDb(config.CSGE_DB);
  const db = getDb(config.CSGE_DB);
  const results = await db.collection('migrationResults')
    .find({ name: { $regex: nameQuery, $options: 'i' } }).toArray();
  for (const r of results as any[]) {
    console.log('migrationResults doc:', JSON.stringify({ runId: r.runId, sourceId: r.sourceId, name: r.name, geminiAgentId: r.geminiAgentId, created: r.created, deployed: r.deployed }, null, 2));
    if (r.runId) {
      const run = await db.collection('migrationRuns').findOne({ _id: r.runId });
      console.log('destination:', JSON.stringify((run as any)?.destination, null, 2));
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
