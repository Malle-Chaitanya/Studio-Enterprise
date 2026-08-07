import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
const c = await MongoClient.connect(config.MONGO_HOST);
const db = c.db(config.CSGE_DB);
const s = await db.collection('migrationSessions').find({}).sort({ _id: -1 }).limit(1).next() as any;
if (!s) console.log('NO SESSION — you need to sign in / connect');
else {
  console.log(`session   : ${s._id}`);
  console.log(`step      : ${s.step}`);
  console.log(`msTenant  : ${s.tenantId ? 'connected' : 'NOT connected'}`);
  console.log(`dvToken   : ${s.dvToken ? 'present' : 'MISSING (Microsoft not connected)'}`);
  console.log(`gEmail    : ${s.gEmail ?? '(none — Google not connected)'}`);
  console.log(`geminiProj: ${s.geminiProject ?? '(none)'}`);
  console.log(`saOk      : ${s.saOk}`);
}
console.log('\n--- credentials by project ---');
for (const d of await db.collection('connectorCredentials').find({}).toArray() as any[]) {
  console.log(`  ${d.connectorId.padEnd(26)} ${d.project}`);
}
await c.close(); process.exit(0);
