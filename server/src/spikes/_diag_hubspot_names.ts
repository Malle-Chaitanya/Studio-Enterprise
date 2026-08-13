import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
for (const env of await discoverEnvironments(cache!.tenantId!)) {
  let token: string; let bots: any[];
  try { token = await clientCredsToken(cache!.tenantId!, env.url); bots = await listBots(env.url, token); } catch { continue; }
  for (const b of bots) if (/hubspot/i.test(b.name)) {
    console.log(`  "${b.name}"  botid=${b.botid}  [${env.name}]`);
  }
}
process.exit(0);
