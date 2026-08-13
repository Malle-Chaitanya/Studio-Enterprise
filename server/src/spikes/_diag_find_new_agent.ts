import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const env = 'https://org32322095.crm.dynamics.com';
const token = await clientCredsToken(cache!.tenantId!, env);
const deployed = new Set((await getDb().collection('adkDeployments').find({}).toArray()).map((d: any) => String(d.sourceId).toLowerCase()));
for (const b of await listBots(env, token)) {
  if (/hubspot|confluence|jira|enterprise agent/i.test(b.name)) {
    console.log(`${deployed.has(b.botid.toLowerCase()) ? 'MIGRATED ' : 'NEW      '} ${b.name.padEnd(30)} ${b.botid}`);
  }
}
process.exit(0);
