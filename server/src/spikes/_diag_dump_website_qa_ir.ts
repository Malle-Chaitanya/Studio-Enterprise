import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const doc = await getDb().collection('agentIRCache')
    .find({ sourceId: '5937b695-7e3e-f111-88b4-6045bd08b5e6' })
    .sort({ $natural: -1 }).limit(1).next();
  if (!doc) { console.log('not found'); process.exit(1); }
  const ir = (doc as any).ir;
  console.log('name:', ir.name);
  console.log('description:', ir.description);
  console.log('instructions:', ir.instructions);
  console.log('capabilities:', JSON.stringify(ir.capabilities, null, 2));
  console.log('\nknowledgeSources:');
  for (const k of ir.knowledgeSources ?? []) {
    console.log(`- kind=${k.kind} name="${k.name}" reference=${k.reference} strategy=${k.classification?.strategy}`);
  }
  console.log('\ntopics count:', ir.topics?.length, ' sample:', (ir.topics ?? []).slice(0, 5).map((t: any) => t.name));
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
