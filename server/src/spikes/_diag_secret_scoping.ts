/** How many distinct customers share the 'default' credential namespace? Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();
for (const coll of ['migrationSessions', 'connectorCredentials', 'adkDeployments', 'stagedAgents']) {
  const byUser = await db.collection(coll).aggregate([
    { $group: { _id: '$appUserId', n: { $sum: 1 } } }, { $sort: { n: -1 } },
  ]).toArray();
  console.log(`${coll}: ${byUser.map((r) => `${r._id ?? '(unset)'}=${r.n}`).join(', ') || '(empty)'}`);
}
const tenants = await db.collection('migrationSessions').distinct('tenantId');
const gprojects = await db.collection('migrationSessions').distinct('geminiProject');
console.log(`distinct Microsoft tenants seen: ${tenants.filter(Boolean).length}`);
console.log(`distinct Google projects seen:  ${gprojects.filter(Boolean).length}`);
const creds = await db.collection('connectorCredentials').find({}).toArray();
for (const c of creds) console.log(`  cred ${c.appUserId} / ${c.connectorId} -> ${Object.values(c.secretIds ?? {}).join(', ')} @ ${c.project}`);
process.exit(0);
