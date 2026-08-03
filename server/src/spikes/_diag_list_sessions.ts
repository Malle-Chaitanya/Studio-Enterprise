import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const sessions = await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(20).toArray();
  for (const s of sessions) {
    console.log(JSON.stringify({ geminiProject: s.geminiProject, gEmail: s.gEmail, tenantId: s.tenantId, _id: s._id }));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
