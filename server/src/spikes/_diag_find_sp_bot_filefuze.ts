import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const rows = await getDb().collection('agentIRCache')
    .find({ 'ir.knowledgeSources.kind': { $regex: 'SharePoint', $options: 'i' } })
    .toArray();
  for (const r of rows as any[]) {
    const sp = (r.ir.knowledgeSources ?? []).filter((k: any) => /sharepoint/i.test(k.kind));
    console.log(`sourceId=${r.sourceId} name="${r.ir.name}"`);
    for (const k of sp) console.log(`  kind=${k.kind} ref=${JSON.stringify(k.reference)} refs=${JSON.stringify(k.references)}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
