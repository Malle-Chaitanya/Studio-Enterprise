/** Is there a live app login, and what does the API expect to see? Reusing the human's OWN
 *  session (they signed in through the browser) is not a bypass — the sign-in happened. The
 *  token is never printed; only its shape and expiry. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = (await getDb().collection('appLoginSessions').find({}).sort({ _id: -1 }).limit(3).toArray()) as Array<Record<string, any>>;
console.log(`${rows.length} login session(s)`);
for (const r of rows) {
  const tok = String(r.token ?? r._id ?? '');
  console.log(`  appUserId=${r.appUserId} email=${r.email} role=${r.role} tokenLen=${tok.length} expires=${String(r.expiresAt ?? r.expires ?? '?')}`);
  console.log(`  fields: ${Object.keys(r).join(', ')}`);
}
process.exit(0);
