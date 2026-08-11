import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const rows = await getDb().collection('agentIRCache').find({}).limit(2000).toArray();
  console.log(`scanning ${rows.length} cached IR docs`);
  const kindCounts: Record<string, number> = {};
  for (const r of rows) {
    for (const k of r.ir?.knowledgeSources ?? []) {
      kindCounts[k.kind] = (kindCounts[k.kind] || 0) + 1;
    }
  }
  console.log('knowledgeSource kind counts:', JSON.stringify(kindCounts, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
