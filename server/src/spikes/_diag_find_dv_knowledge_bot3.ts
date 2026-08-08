import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const rows = await getDb().collection('agentIRCache')
    .find({ 'ir.knowledgeSources.kind': 'DataverseStructuredSearchSource' })
    .toArray();
  for (const r of rows) {
    const ks = (r.ir.knowledgeSources ?? []).filter((k: any) => k.kind === 'DataverseStructuredSearchSource');
    console.log(`sourceId=${r.sourceId} name="${r.ir.name}" appUserId=${r.appUserId}`);
    console.log('knowledgeSources:', JSON.stringify(ks, null, 2));
  }
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
