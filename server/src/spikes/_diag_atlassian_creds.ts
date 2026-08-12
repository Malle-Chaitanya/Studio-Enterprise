/** Are Atlassian creds saved, and does their base_url match the agent's spaces? Throwaway. */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
const c = await MongoClient.connect(config.MONGO_HOST);
const db = c.db(config.CSGE_DB);

console.log('=== connectorCredentials ===');
for (const d of await db.collection('connectorCredentials').find({}).toArray() as any[]) {
  console.log(`${d.connectorId}  project=${d.project}  fields=${JSON.stringify(d.fields)}`);
  console.log(`   secretIds=${JSON.stringify(d.secretIds)}`);
}

console.log('\n=== Confluence_agent knowledge sources (mapped.ir) ===');
const r = await db.collection('stagedAgents').findOne({ name: 'Confluence_agent' }, { sort: { _id: -1 } }) as any;
for (const k of (r?.mapped?.ir?.knowledgeSources ?? [])) {
  console.log(`- kind=${k.kind} name="${k.name}"`);
  console.log(`  refs=${JSON.stringify(k.references)}`);
  console.log(`  cls=${JSON.stringify(k.classification)}`);
  if (k.raw) console.log(`  raw=${JSON.stringify(k.raw).slice(0, 400)}`);
}
await c.close();
process.exit(0);
