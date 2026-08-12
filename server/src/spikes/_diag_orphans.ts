/** Reasoning Engines that no adkDeployments row points at — deployed, billable, unreferenced. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';

const P = 'studio-enterprise-migration';
const L = 'us-central1';
await connectMongo();
const rows = await getDb().collection('adkDeployments').find({}).toArray();
const known = new Set(rows.map((r) => String((r as { reasoningEngine?: string }).reasoningEngine ?? '').split('/').pop()).filter(Boolean));
const token = await getSaToken();
const res = await fetch(`https://${L}-aiplatform.googleapis.com/v1beta1/projects/${P}/locations/${L}/reasoningEngines`, {
  headers: { Authorization: `Bearer ${token}` },
});
const j = (await res.json()) as { reasoningEngines?: Array<{ name: string; displayName: string; createTime: string }> };
const eng = (j.reasoningEngines ?? []).sort((a, b) => a.createTime.localeCompare(b.createTime));
let orphans = 0;
for (const e of eng) {
  const id = e.name.split('/').pop()!;
  const o = !known.has(id);
  if (o) orphans++;
  console.log(`  ${id}  ${e.createTime.slice(0, 19)}  ${e.displayName.padEnd(30)} ${o ? 'ORPHAN' : 'tracked'}`);
}
console.log(`\n${eng.length} engines, ${orphans} orphaned (deployed, billable, referenced by nothing)`);
process.exit(0);
