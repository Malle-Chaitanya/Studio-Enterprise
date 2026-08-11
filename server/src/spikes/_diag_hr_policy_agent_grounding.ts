import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

const SOURCE_ID = 'ad009852-cea1-436f-849d-5079a93fd5b4'; // HR Policy Assistant

async function main() {
  await connectMongo();
  const db = getDb();

  const result = await db.collection('migrationResults').find({ sourceId: SOURCE_ID }).sort({ $natural: -1 }).limit(1).next();
  console.log('=== migrationResults ===');
  console.log(JSON.stringify(result, null, 2));

  const adk = await db.collection('adkDeployments').find({ sourceId: SOURCE_ID }).sort({ $natural: -1 }).limit(1).next();
  console.log('\n=== adkDeployments ===');
  console.log(JSON.stringify(adk, null, 2));

  const snap = await db.collection('migratedAgentSnapshots').find({ sourceId: SOURCE_ID }).sort({ $natural: -1 }).limit(1).next();
  console.log('\n=== migratedAgentSnapshots (exists?) ===');
  console.log(snap ? 'yes, updatedAt=' + JSON.stringify((snap as any).updatedAt) : 'none');

  process.exit(0);
}
main().catch((e) => { console.error('ERR', e.message); process.exit(1); });
