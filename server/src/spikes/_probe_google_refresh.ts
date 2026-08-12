/**
 * Will the Google connection survive the demo?
 *
 * A user access token dies about an hour after sign-in. If the session kept a refresh
 * token, the run mints a fresh one per request and the demo is safe; if the refresh itself
 * fails, everything looks fine until the moment someone clicks Migrate. Prove the exchange
 * works now rather than discovering it on stage.
 *
 * Prints only whether a token came back and its expiry — never a token value.
 *
 * npx tsx src/spikes/_probe_google_refresh.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { refreshGoogleToken } from '../auth/google.js';

await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ gRefreshToken: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { gEmail?: string; gRefreshToken?: string; geminiProject?: string } | null;

if (!s?.gRefreshToken) {
  console.log('NO SESSION with a refresh token — the demo must reconnect Google first.');
  process.exit(0);
}
console.log(`session: ${s.gEmail ?? '(no email)'}  project=${s.geminiProject ?? '(none)'}`);
try {
  const fresh = await refreshGoogleToken(s.gRefreshToken);
  console.log(`refresh exchange: OK — received a token of ${fresh ? String(fresh).length : 0} chars (value not printed)`);
} catch (e) {
  console.log(`refresh exchange: FAILED — ${(e as Error).message.slice(0, 300)}`);
  console.log('The demo will fail at the migrate step. Reconnect Google before showing it.');
}
process.exit(0);
