/** Looks for a stored migrationSessions record connected to Migrationn.com / a different
 *  Google project than studio-enterprise-migration, so we can check ben's real state there
 *  the same way we've been doing for the other tenant all session.
 *   npx tsx src/spikes/_diag_find_migrationn_session.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const sessions = await getDb().collection('migrationSessions')
    .find({}, { projection: { gEmail: 1, geminiProject: 1, tenantId: 1, environments: 1, msTenantDomain: 1, createdAt: 1, updatedAt: 1 } })
    .sort({ $natural: -1 })
    .limit(20)
    .toArray();
  for (const s of sessions) {
    console.log(JSON.stringify({
      _id: s._id,
      gEmail: (s as any).gEmail,
      geminiProject: (s as any).geminiProject,
      tenantId: (s as any).tenantId,
      envNames: ((s as any).environments ?? []).map((e: any) => e.name),
      updatedAt: (s as any).updatedAt,
    }));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
