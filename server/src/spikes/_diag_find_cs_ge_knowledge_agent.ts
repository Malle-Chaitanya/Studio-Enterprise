import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const rows = await getDb().collection('agentIRCache').find({ 'ir.name': /CS_GE Knowledge Test Agent/i }).sort({ $natural: -1 }).limit(1).toArray();
  for (const r of rows as any[]) {
    console.log('sourceId=', r.sourceId, 'name=', r.ir.name);
    for (const k of r.ir.knowledgeSources ?? []) {
      console.log(`  kind=${k.kind} name="${k.name}" ref=${JSON.stringify(k.reference)} classification=${JSON.stringify(k.classification)}`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
