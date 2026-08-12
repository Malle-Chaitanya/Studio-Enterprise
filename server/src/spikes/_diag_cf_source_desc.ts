import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
const c = await MongoClient.connect(config.MONGO_HOST);
const db = c.db(config.CSGE_DB);
const r = await db.collection('stagedAgents').findOne({ name: 'Enterprise Migration Knowledge' }, { sort: { _id: -1 } }) as any;
for (const k of (r?.mapped?.ir?.knowledgeSources ?? [])) {
  if (!/Federated|Confluence/i.test(k.kind ?? '') && !/confluence/i.test(k.classification?.strategy ?? '')) continue;
  console.log(`name        : ${k.name}`);
  console.log(`description : ${k.description ?? '(none)'}`);
  console.log(`refs        : ${JSON.stringify(k.references)}`);
  console.log(`spaceNames  : ${JSON.stringify(k.confluenceSpaceNames ?? '(none)')}`);
  console.log(`notes       : ${JSON.stringify(k.classification?.notes ?? [], null, 1).slice(0, 700)}`);
}
await c.close(); process.exit(0);
