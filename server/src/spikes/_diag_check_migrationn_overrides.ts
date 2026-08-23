import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const s = await getDb().collection('migrationSessions').findOne({ _id: '6M4_6XGYGMUQW7LqKQJdm3X8qRs' as never });
  console.log('identityOverrides on the session doc:', JSON.stringify((s as any)?.identityOverrides ?? (s as any)?.identityMap, null, 2));

  // Also check a dedicated collection, in case overrides live separately.
  const coll = await getDb().listCollections().toArray();
  console.log('\nAll collections:', coll.map((c) => c.name).join(', '));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
