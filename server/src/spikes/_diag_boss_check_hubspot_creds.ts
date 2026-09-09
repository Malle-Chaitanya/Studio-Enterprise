import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { listConnectorCredentials } from '../db/repos/connectorCredentials.js';

const APP_USER_ID = '6a5dfdff7cf05623332758b7';

async function main() {
  await connectMongo();
  const creds = await listConnectorCredentials(APP_USER_ID);
  console.log(`Found ${creds.length} connector credential record(s) for this account:\n`);
  for (const c of creds) {
    console.log(`- connectorId: ${c.connectorId}`);
    console.log(`  fields: ${c.fields?.join(', ')}`);
    console.log(`  project: ${c.project}`);
    console.log(`  updatedAt: ${c.updatedAt}`);
    console.log('');
  }
  const hubspotLike = creds.filter((c) => /hubspot/i.test(c.connectorId));
  console.log('HubSpot-matching records:', JSON.stringify(hubspotLike, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
