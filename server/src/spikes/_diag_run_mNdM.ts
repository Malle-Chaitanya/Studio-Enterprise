import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const db = getDb();
const m = await db.collection('migrationResults')
  .find({ runId: 'mNdMWLqAzldRGb5mwQxwgI0icco' }).toArray();
for (const x of m) console.log(JSON.stringify(x, null, 1));
process.exit(0);
