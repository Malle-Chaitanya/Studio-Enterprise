/** Newest app login id — the csge_auth cookie value requireAuth expects. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const l = await getDb().collection('appLoginSessions').find({}).sort({ expiresAt: -1 }).limit(1).next() as any;
if (!l) throw new Error('no app login — the operator must sign in to the app UI');
console.log(String(l._id));
process.exit(0);
