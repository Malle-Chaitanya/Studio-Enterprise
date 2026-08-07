/** Print the newest session id, for hitting the API by hand.
 *  npx tsx src/spikes/_diag_session_id.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const s = await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next();
console.log(`SESSION_ID=${s?._id ?? s?.id ?? ''}`);
console.log(`tenant=${s?.tenantId ?? '-'} env=${s?.dvOrgUrl ?? '-'} project=${s?.geminiProject ?? '-'}`);
process.exit(0);
