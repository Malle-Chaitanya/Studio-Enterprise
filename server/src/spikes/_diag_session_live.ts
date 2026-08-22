import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const s = (await db.collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Record<string, unknown> | null;
if (!s) { console.log('no session'); process.exit(0); }
const now = Date.now();
console.log('keys:', Object.keys(s).join(', '));
for (const k of ['appUserId', 'tenantId', 'geminiProject', 'expiresAt', 'msTokenExpiresAt']) {
  console.log(`  ${k.padEnd(18)} ${JSON.stringify(s[k])}`);
}
// Token presence only — never the value.
for (const k of Object.keys(s)) {
  if (/token|secret/i.test(k)) {
    const v = s[k];
    console.log(`  ${k.padEnd(18)} ${typeof v === 'string' ? `present (${v.length} chars)` : JSON.stringify(v)}`);
  }
}
const exp = s.expiresAt ? new Date(String(s.expiresAt)).getTime() : 0;
console.log(`\nsession ${exp > now ? 'VALID' : 'EXPIRED'} (expiresAt ${s.expiresAt})`);
process.exit(0);
