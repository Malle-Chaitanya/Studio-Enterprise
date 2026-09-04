import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();
const rec = await db.collection('connectorCredentials').findOne({ connectorId: 'shared_onedrive', appUserId: '6a5dfdff7cf05623332758b7' });
console.log(JSON.stringify(rec, null, 2));
process.exit(0);
