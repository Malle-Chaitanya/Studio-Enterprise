/** What environments/tenants do we have cached? Read-only. */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';

const mc = await MongoClient.connect(config.MONGO_HOST, { serverSelectionTimeoutMS: 5000 });
const db = mc.db(config.CSGE_DB);
console.log('collections:', (await db.listCollections().toArray()).map((c) => c.name).join(', '));
const rows = await db.collection('environmentsCache').find({}).limit(5).toArray();
console.log('environmentsCache rows:', rows.length);
for (const r of rows) console.log(JSON.stringify(r).slice(0, 1200));
await mc.close();
process.exit(0);
