import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  for (const geminiAgentId of ['13300623640757970256', '2261370940660059563']) {
    const result = await getDb().collection('migrationResults').findOne({ geminiAgentId });
    if (!result) { console.log(`\n${geminiAgentId}: NOT FOUND (still not persisted, or run failed before writing)`); continue; }
    console.log(`\n=== ${(result as any).name} (${geminiAgentId}) ===`);
    console.log('shared:', (result as any).shared, ' updatedAt:', (result as any).updatedAt);
    console.log('permissionHandoff:', JSON.stringify((result as any).permissionHandoff, null, 2));
    const sharingNotes = ((result as any).fidelity ?? []).filter((f: any) => f.component === 'sharing');
    console.log('sharing notes:', JSON.stringify(sharingNotes, null, 2));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
