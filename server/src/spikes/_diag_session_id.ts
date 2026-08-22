/** Print the current session id and what it carries, so an endpoint can be exercised
 *  exactly as the browser would. Read-only.
 *  cd server && npx tsx src/spikes/_diag_session_id.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as
  | Record<string, unknown>
  | null;
if (!s) { console.log('no session'); process.exit(0); }
console.log(`id       : ${String(s._id ?? s.id)}`);
console.log(`gEmail   : ${s.gEmail ?? '-'}`);
console.log(`tenantId : ${s.tenantId ? 'set' : '-'}`);
console.log(`appUserId: ${s.appUserId ?? '-'}`);
console.log(`keys     : ${Object.keys(s).join(', ')}`);
process.exit(0);
