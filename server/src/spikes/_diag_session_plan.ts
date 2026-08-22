/** The exact destination + units the last UI run stored, so a scripted run reuses the human's
 *  choices instead of inventing coordinates (hardcoding an engine id is forbidden, and the
 *  session is the only record of what the customer actually picked). */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({}).sort({ _id: -1 }).limit(1).next()) as Record<string, any> | null;
console.log('sessionId:', String(s?._id));
console.log('plan keys:', Object.keys(s?.plan ?? {}).join(', '));
console.log('destination:', JSON.stringify(s?.plan?.destination ?? {}));
for (const u of s?.plan?.units ?? []) {
  console.log(`unit env="${u.envName}" url=${u.envUrl}`);
  for (const b of u.bots ?? []) console.log(`   ${b.botid}  ${b.name}`);
}
console.log('savedConnectors:', (s?.plan?.savedConnectors ?? []).length);
process.exit(0);
