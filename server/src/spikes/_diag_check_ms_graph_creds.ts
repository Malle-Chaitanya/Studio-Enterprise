import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();
const entra = await db.collection('entraAppCredentials').find({}).toArray();
console.log(`entraAppCredentials: ${entra.length} record(s)`);
for (const e of entra) console.log(`  appUserId=${e.appUserId} tenantId=${e.tenantId} secretName=${e.secretName ?? 'n/a'}`);

const connCreds = await db.collection('connectorCredentials').find({}).toArray();
console.log(`\nconnectorCredentials: ${connCreds.length} record(s)`);
for (const c of connCreds) console.log(`  ${JSON.stringify(c).slice(0, 200)}`);
process.exit(0);
