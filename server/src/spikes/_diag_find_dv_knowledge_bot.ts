import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const rows = await getDb().collection('agentIRCache')
    .find({ 'ir.knowledgeSources.kind': { $in: ['DataverseTableSearch', 'dataverse-snapshot'] } })
    .limit(10)
    .toArray();
  console.log(`found ${rows.length} cached IR(s) with Dataverse table knowledge`);
  for (const r of rows) {
    const ks = (r.ir.knowledgeSources ?? []).filter((k: any) => /dataverse/i.test(k.kind ?? ''));
    console.log(`- sourceId=${r.sourceId} name="${r.ir.name}" knowledgeSources=${JSON.stringify(ks.map((k: any) => ({ kind: k.kind, ref: k.reference })))}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
