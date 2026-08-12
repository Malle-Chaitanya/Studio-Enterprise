/** Find bots by name across all cached environments. Read-only. */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
const NEEDLES = process.argv.slice(2).map((s) => s.toLowerCase());
const c = await MongoClient.connect(config.MONGO_HOST);
const db = c.db(config.CSGE_DB);
const cached = await db.collection('environmentsCache').find({}).sort({ _id: -1 }).limit(1).next() as any;
await c.close();
const tenantId = cached?.tenantId;
const envs: Array<{ url: string; name: string }> = (cached?.environments ?? cached?.envs ?? [])
  .filter((e: any) => e.accessible !== false)
  .map((e: any) => ({ url: e.url, name: e.name }));
console.log(`tenant=${tenantId}  environments=${envs.length}`);
for (const env of envs) {
  try {
    const token = await clientCredsToken(tenantId, env.url);
    const bots = await listBots(env.url, token);
    for (const b of bots as any[]) {
      if (NEEDLES.some((n) => (b.name ?? '').toLowerCase().includes(n))) {
        console.log(`FOUND "${b.name}"\n   env=${env.name}\n   envUrl=${env.url}\n   botid=${b.botid}`);
      }
    }
  } catch (e) { console.log(`  ${env.name}: ${(e as Error).message.slice(0, 80)}`); }
}
process.exit(0);
