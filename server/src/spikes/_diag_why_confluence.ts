/** Knowledge Assistant got live Confluence tools. Its IR showed ONE agentTool with undefined
 *  connectorId/operationId, so where did Confluence come from? Print the raw tool entries and
 *  every field, plus anything in the IR that names confluence — wiring a connector the source
 *  agent never had is a fidelity error (capability the customer did not ask for). */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const row = (await getDb()
  .collection('stagedAgents')
  .find({ sourceId: 'ca57b355-d08b-f111-8076-0022480b19e9' })
  .sort({ _id: -1 })
  .limit(1)
  .next()) as Record<string, any> | null;
const ir = row?.mapped?.ir ?? {};
console.log(`agent: ${row?.displayName}`);
console.log(`\n--- agentTools (${(ir.agentTools ?? []).length}) raw ---`);
for (const t of ir.agentTools ?? []) console.log(JSON.stringify(t));
console.log(`\n--- knowledgeSources ---`);
for (const k of ir.knowledgeSources ?? []) console.log(`${String(k.kind).padEnd(34)} ${String(k.name ?? '?')}  url=${String(k.url ?? k.address ?? '-').slice(0, 90)}`);
const blob = JSON.stringify(ir);
console.log(`\n--- the string "confluence" appears ${(blob.match(/confluence/gi) ?? []).length} time(s) in the IR ---`);
// Where exactly? Walk the IR and print each path whose value mentions it, so the answer is a
// location and not a guess.
(function walk(v: unknown, path: string) {
  if (typeof v === 'string') {
    if (/confluence/i.test(v)) console.log(`  ${path} = ${v.slice(0, 160)}`);
    return;
  }
  if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`));
  if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
})(ir, 'ir');
process.exit(0);
