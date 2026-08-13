import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('adkDeployments').find({}).toArray();
for (const r of rows as any[]) console.log(JSON.stringify(r).slice(0, 700), '\n');
process.exit(0);
