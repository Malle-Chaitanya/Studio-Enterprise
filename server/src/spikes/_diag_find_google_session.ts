/** Find a migrationSessions row with Google connected (geminiProject + gEmail set),
 *  so the impersonation-domain-check test has a real session id + admin domain to
 *  target without needing a fresh OAuth login.
 *  npx tsx src/spikes/_diag_find_google_session.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const rows = await getDb()
    .collection('migrationSessions')
    .find({ geminiProject: { $exists: true, $ne: null }, gEmail: { $exists: true, $ne: null } })
    .project({ _id: 1, geminiProject: 1, gEmail: 1, tenantId: 1 })
    .sort({ $natural: -1 })
    .limit(5)
    .toArray();
  for (const r of rows) {
    console.log(JSON.stringify({ sessionId: r._id, geminiProject: r.geminiProject, gEmail: r.gEmail, tenantId: r.tenantId }));
  }
  if (rows.length === 0) console.log('NO SESSION WITH GOOGLE CONNECTED FOUND');
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
