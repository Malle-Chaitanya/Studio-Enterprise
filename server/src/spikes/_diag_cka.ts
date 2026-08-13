/** What does "Confluence Knowledge Assistant" actually carry? Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
await connectMongo();
const rows = await getDb().collection('agentIRCache').find<any>({}).toArray();
for (const r of rows) {
  const ir = r.ir; if (!ir) continue;
  const n = ir.displayName ?? ir.name ?? '';
  if (!/confluence/i.test(n)) continue;
  console.log(`\n=== ${n}  (env=${r.envUrl})`);
  for (const k of ir.knowledgeSources ?? []) {
    console.log(`  KS ${k.kind}  name="${k.name}"  spaces=${JSON.stringify(k.confluenceSpaceNames)}  strategy=${k.classification?.strategy}`);
  }
  for (const t of ir.agentTools ?? []) console.log(`  TOOL ${t.kind}:${t.name}  connector=${t.connectorId ?? '-'} op=${t.operationId ?? '-'}`);
}
process.exit(0);
