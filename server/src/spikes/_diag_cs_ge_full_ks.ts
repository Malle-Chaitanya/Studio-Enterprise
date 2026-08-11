import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const rows = await getDb().collection('agentIRCache').find({ 'ir.name': /CS_GE Knowledge Test Agent/i }).sort({ $natural: -1 }).limit(1).toArray();
  for (const r of rows as any[]) {
    const ks = (r.ir.knowledgeSources ?? []).filter((k: any) => k.kind === 'FederatedStructuredSearchSource');
    console.log(JSON.stringify(ks, null, 2));
  }
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
