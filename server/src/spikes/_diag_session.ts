/** Print the latest session's Google/destination fields, to see why live is blocked. */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s) { console.log('no session'); process.exit(0); }
  console.log('gEmail:        ', s.gEmail ?? '(none)');
  console.log('geminiProject: ', s.geminiProject ?? '(none)');
  console.log('saOk:          ', s.saOk ?? false);
  console.log('saReason:      ', s.saReason ?? '(none)');
  console.log('msConnected:   ', Boolean(s.dvToken));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
