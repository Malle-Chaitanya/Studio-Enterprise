/** One-off: is there a usable stored session (tenantId) to run live Dataverse diagnostics against?
 *  npx tsx src/spikes/_diag_check_session.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const s = (await getDb()
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;

if (!s) {
  console.log('NO_SESSION');
} else {
  console.log('SESSION_FOUND');
  console.log('tenantId present:', !!s.tenantId);
  console.log('keys on session:', Object.keys(s).join(', '));
}
process.exit(0);
