import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
const c = await MongoClient.connect(config.MONGO_HOST);
const db = c.db(config.CSGE_DB);
const colls = (await db.listCollections().toArray()).map(x => x.name).filter(n => /adkDeployment/i.test(n));
for (const n of colls) {
  for (const d of await db.collection(n).find({}).toArray() as any[]) {
    console.log(`${n}: agentId=${d.agentId} project=${d.project} sourceId=${d.sourceId}`);
  }
}
await c.close(); process.exit(0);
