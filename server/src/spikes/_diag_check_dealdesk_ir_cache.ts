/** Is Deal Desk's original extracted AgentIR cached anywhere in Mongo, so a clone can
 *  reuse the exact real instruction/description instead of approximating it?
 *  npx tsx src/spikes/_diag_check_dealdesk_ir_cache.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const db = getDb();
const cols = await db.listCollections().toArray();
console.log('Collections:', cols.map((c) => c.name).join(', '));

const hit = await db.collection('agentIRCache').find({ name: /deal desk/i }).toArray();
console.log(`\nagentIRCache matching "deal desk": ${hit.length}`);
for (const h of hit) {
  console.log(`  - name=${h.name} instruction length=${(h.instructions ?? '').length} appUserId=${h.appUserId}`);
}
process.exit(0);
