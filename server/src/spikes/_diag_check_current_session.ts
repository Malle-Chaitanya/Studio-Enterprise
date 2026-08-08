/**
 * Verify the 2026-08-07 Google-token-refresh fix: this session predates the
 * fix (connected before gRefreshToken existed), so it has none stored and
 * refreshGoogleToken can't help it — confirms the "needs one reconnect" claim
 * rather than assuming it.
 */
import { connectMongo } from '../db/mongo.js';
import { getSession } from '../sessionStore.js';

const ID = 'W71JbP6X0Xnn5c5uzY1N9DAud2Y';
await connectMongo();
const s = await getSession(ID);
console.log('hasGToken:', Boolean(s?.gToken), 'hasGRefreshToken:', Boolean(s?.gRefreshToken));
process.exit(0);
