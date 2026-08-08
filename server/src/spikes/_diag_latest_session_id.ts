import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const s = await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next();
  if (!s) { console.log('no session'); process.exit(1); }
  console.log('id:', s._id);
  console.log('step:', (s as any).step);
  console.log('tenantId:', (s as any).tenantId);
  console.log('environments:', ((s as any).environments ?? []).map((e: any) => e.name));
  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
