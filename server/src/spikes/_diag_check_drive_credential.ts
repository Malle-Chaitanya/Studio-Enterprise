import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const cc = await getDb().collection('connectorCredentials').find({ connectorId: 'shared_googledrive' }).toArray();
  console.log(`connectorCredentials rows for shared_googledrive: ${cc.length}`);
  console.log(JSON.stringify(cc.map((c) => ({ connectorId: c.connectorId, appUserId: c.appUserId, hasSecretIds: !!c.secretIds, fields: Object.keys(c.secretIds ?? {}) })), null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
