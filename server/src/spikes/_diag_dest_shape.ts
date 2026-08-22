/** Dump the field names of the newest run/result so the destination can be read off a real
 *  document instead of guessed field names. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const run = await db.collection('migrationRuns').find({}).sort({ _id: -1 }).limit(1).next();
console.log('RUN keys:', Object.keys(run ?? {}).join(', '));
console.log(JSON.stringify(run, null, 1).slice(0, 1200));
const res = await db.collection('migrationResults').find({}).sort({ _id: -1 }).limit(1).next();
console.log('\nRESULT keys:', Object.keys(res ?? {}).join(', '));
process.exit(0);
