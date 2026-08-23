import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const docs = await getDb().collection('identityMappings')
    .find({ $or: [
      { tenantId: '807d6772-847c-40e2-9bec-e2c930b3a42e' },
      { 'users.erik@filefuze.co': { $exists: true } },
      { 'users.alex@filefuze.co': { $exists: true } },
    ] })
    .toArray();
  console.log(JSON.stringify(docs, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
