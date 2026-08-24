import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const sessions = await getDb().collection('migrationSessions')
    .find({ gEmail: { $in: ['zara@storefuze.com'] } })
    .sort({ $natural: -1 })
    .limit(3)
    .toArray();
  for (const s of sessions) {
    console.log({
      _id: s._id,
      appUserId: s.appUserId,
      gEmail: s.gEmail,
      geminiProject: s.geminiProject,
      tenantId: s.tenantId,
      saOk: s.saOk,
      saReason: s.saReason,
    });
  }
  if (!sessions.length) console.log('No session found with gEmail=zara@storefuze.com');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
