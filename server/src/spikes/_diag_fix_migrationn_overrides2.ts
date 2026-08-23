import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const coll = getDb().collection('identityMappings');
  const filter = { tenantId: '807d6772-847c-40e2-9bec-e2c930b3a42e', appUserId: '6a5dfdff7cf05623332758b7' };
  const before = await coll.findOne(filter);
  console.log('BEFORE:', JSON.stringify(before, null, 2));

  const correctedUsers = {
    'erik@filefuze.co': 'admin@migrationn.com',
    'alex@filefuze.co': 'alex@migrationn.com',
    'ben@filefuze.co': 'ben@migrationn.com',
  };
  const res = await coll.updateOne(filter, { $set: { users: correctedUsers, updatedAt: new Date().toISOString() } });
  console.log('\nmatched:', res.matchedCount, 'modified:', res.modifiedCount);

  const after = await coll.findOne(filter);
  console.log('\nAFTER:', JSON.stringify(after, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
