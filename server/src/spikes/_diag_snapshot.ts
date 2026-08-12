import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
const c = await MongoClient.connect(config.MONGO_HOST);
const db = c.db(config.CSGE_DB);
for (const d of await db.collection('migratedAgentSnapshots')
  .find({ sourceId: 'bdf9b817-9b90-f111-b8da-0022480b1f83' }).toArray() as any[]) {
  console.log(`project=${d.project}  engine=${d.engine ?? '-'}  connectorIds=${JSON.stringify(d.snapshot?.connectorIds ?? '(absent)')}  updatedAt=${d.updatedAt ?? '-'}`);
}
console.log('--- all keys of one doc ---');
const one = await db.collection('migratedAgentSnapshots').findOne({ sourceId: 'bdf9b817-9b90-f111-b8da-0022480b1f83' }) as any;
console.log(Object.keys(one ?? {}).join(', '));
await c.close(); process.exit(0);
