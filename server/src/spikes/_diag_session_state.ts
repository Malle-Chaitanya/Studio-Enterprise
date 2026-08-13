import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(3).toArray();
for (const s of rows as any[]) {
  console.log(`\nsession ${s.id ?? s._id}  appUserId=${s.appUserId}`);
  console.log(`  gEmail=${s.gEmail}  gToken=${s.gToken ? 'present' : 'MISSING'}  gRefresh=${s.gRefreshToken ? 'present' : 'MISSING'}`);
  console.log(`  geminiProject=${s.geminiProject}  tenantId=${s.tenantId ? 'present' : 'MISSING'}`);
  console.log(`  environments=${(s.environments ?? []).map((e: any) => e.name).join(', ')}`);
  console.log(`  plan.destination=${JSON.stringify(s.plan?.destination ?? null).slice(0, 300)}`);
}
process.exit(0);
