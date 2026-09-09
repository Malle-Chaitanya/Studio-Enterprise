import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const gmailCreds = await getDb().collection('connectorCredentials').find({ connectorId: 'shared_gmail' }).toArray();
  console.log(`connectorCredentials rows for shared_gmail (ANY app user, ever): ${gmailCreds.length}`);
  console.log(JSON.stringify(gmailCreds.map((c) => ({ appUserId: c.appUserId, fields: Object.keys(c.secretIds ?? {}) })), null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
