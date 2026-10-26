import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';

await connectMongo();
const db = getDb(config.CSGE_DB);

const docs = await db
  .collection('migrationLogs')
  .find({ message: { $regex: /catalog-override.*(Google Calendar|Gmail)/i } })
  .sort({ _id: -1 })
  .limit(20)
  .toArray();

if (docs.length === 0) {
  console.log('No migrationLogs entries matching catalog-override for Calendar/Gmail. Trying a broader search...');
  const any = await db
    .collection('migrationLogs')
    .find({ message: { $regex: /catalog-override/i } })
    .sort({ _id: -1 })
    .limit(30)
    .toArray();
  for (const d of any) console.log((d as any).message);
} else {
  for (const d of docs) console.log((d as any).message);
}
process.exit(0);
