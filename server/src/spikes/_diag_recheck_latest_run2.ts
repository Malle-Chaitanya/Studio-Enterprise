import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const results = await getDb().collection('migrationResults')
    .find({ name: { $in: ['WorkMate', 'Nexus Agent', 'Migrate Advisor'] } })
    .sort({ updatedAt: -1 })
    .limit(6)
    .toArray();
  for (const r of results) {
    console.log(`\n${(r as any).name} | geminiAgentId=${(r as any).geminiAgentId} | updatedAt=${(r as any).updatedAt} | shared=${(r as any).shared}`);
    console.log('  grantUsers:', JSON.stringify((r as any).permissionHandoff?.grantUsers));
    console.log('  unresolved:', JSON.stringify((r as any).permissionHandoff?.unresolved));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
