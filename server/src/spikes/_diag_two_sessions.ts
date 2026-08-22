/** Why two sessions on one tenant answer the licence question differently. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const ids = ['VlZxhU2ozkvrz0bxbF1DgUhnF0U', 'pCHN8ddMKoHnCng1-TieyXl4A_8'];
for (const id of ids) {
  const s = await getDb().collection('migrationSessions').findOne({ _id: id } as any) as any;
  if (!s) { console.log(id, '-> NOT FOUND'); continue; }
  console.log(`${id}`);
  console.log(`   geminiProject : ${s.geminiProject ?? '(unset)'}`);
  console.log(`   gEmail        : ${s.gEmail ?? '-'}`);
  console.log(`   saOk          : ${s.saOk}`);
  console.log(`   tenantId      : ${s.tenantId ?? '-'}`);
  console.log(`   appUserId     : ${s.appUserId ?? '(default)'}`);
  console.log(`   plan?         : ${!!s.plan}  selectedAgents=${(s.plan?.agents ?? s.plan?.scope?.agents ?? []).length}`);
}
process.exit(0);
