import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const s = await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next();
  console.log('SESSION envUrl:', (s as any)?.envUrl, 'msTenant:', (s as any)?.msTenantId ?? (s as any)?.tenantId);
  const staged = await getDb().collection('stagedAgents').find({}).sort({ $natural: -1 }).limit(3).toArray();
  console.log('STAGED sample envUrls:', staged.map((x: any) => x.envUrl));
}
main().then(() => process.exit(0)).catch((e) => { console.error('ERR', e.message); process.exit(0); });
