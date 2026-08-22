/** Is there a live migration session, and what is connected on it? */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const rows = await db.collection('migrationSessions').find({}).sort({ _id: -1 }).limit(3).toArray() as any[];
console.log('migrationSessions:', rows.length);
for (const s of rows) {
  console.log('---', String(s._id));
  console.log('  createdAt   :', s.createdAt ?? s._id.getTimestamp?.().toISOString());
  console.log('  expiresAt   :', s.expiresAt);
  console.log('  ms connected:', !!s.refreshToken, 'tenant:', s.tenantId ?? '-');
  console.log('  google      :', s.gEmail ?? '-', 'project:', s.geminiProject ?? '-');
}
const logins = await db.collection('appLoginSessions').countDocuments({});
console.log('appLoginSessions:', logins);
process.exit(0);
