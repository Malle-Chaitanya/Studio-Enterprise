import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  for (const name of ['Migrate Advisor', 'Nexus', 'WorkMate']) {
    const result = await getDb().collection('migrationResults')
      .find({ name })
      .sort({ $natural: -1 })
      .limit(1)
      .next();
    console.log(`\n=== ${name} ===`);
    console.log('geminiAgentId:', (result as any)?.geminiAgentId, ' shared:', (result as any)?.shared);
    console.log('permissionHandoff.grantUsers:', JSON.stringify((result as any)?.permissionHandoff?.grantUsers));
    console.log('permissionHandoff.unresolved:', JSON.stringify((result as any)?.permissionHandoff?.unresolved));
    console.log('permissionHandoff.reason:', (result as any)?.permissionHandoff?.reason);
    const sharingNotes = ((result as any)?.fidelity ?? []).filter((f: any) => f.component === 'sharing');
    console.log('sharing fidelity notes:', JSON.stringify(sharingNotes, null, 2));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
