/** Full lossless AgentIR for the "workmate" agent as extracted from Copilot
 *  Studio / Dataverse (the EXTRACT-phase staged record, not the Gemini side).
 *  npx tsx src/spikes/_diag_dump_workmate_source_ir.ts */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

async function main() {
  await connectMongo();
  const count = await getDb().collection('stagedAgents').countDocuments({ name: /workmate/i });
  const row = (await getDb()
    .collection('stagedAgents')
    .find({ name: /workmate/i })
    .sort({ $natural: -1 })
    .limit(1)
    .next()) as any;

  if (!row) { console.log('No staged "workmate" record found.'); process.exit(0); }
  const ir = row.mapped?.ir ?? {};

  console.log(`${count} staged record(s) matching "workmate" — showing the most recent extraction only.\n`);
  console.log(`name: ${ir.name}`);
  console.log(`sourceId (Dataverse botid): ${ir.sourceId}`);
  console.log(`appUserId: ${row.appUserId}`);
  console.log(`stagedAt: ${row.stagedAt ?? row._id?.getTimestamp?.()}`);
  console.log(`\ndescription: ${ir.description}`);
  console.log(`\ninstructions:\n${ir.instructions}`);
  console.log(`\ncapabilities: ${JSON.stringify(ir.capabilities)}`);
  console.log(`starterPrompts: ${JSON.stringify(ir.starterPrompts)}`);

  console.log(`\n--- topics (${ir.topics?.length ?? 0}) ---`);
  for (const t of ir.topics ?? []) {
    console.log(`  - ${t.name}${t.isSystem ? ' [system]' : ''}${t.isChildAgent ? ' [child-agent]' : ''} (${t.triggerPhrases?.length ?? 0} triggers)`);
  }

  console.log(`\n--- knowledge sources (${ir.knowledgeSources?.length ?? 0}) ---`);
  for (const k of ir.knowledgeSources ?? []) {
    console.log(`  - ${k.kind ?? k.name ?? JSON.stringify(k).slice(0, 100)}`);
  }

  console.log(`\n--- agent tools / connectors (${ir.agentTools?.length ?? 0}) ---`);
  for (const tool of ir.agentTools ?? []) {
    console.log(`  - connectorId=${tool.connectorId} operationId=${tool.operationId} name=${tool.name ?? ''}`);
  }

  console.log(`\n--- permissions ---`);
  console.log(JSON.stringify(ir.permissions, null, 2));

  console.log(`\n--- unmapped (lossless-extraction leftovers) ---`);
  console.log(JSON.stringify(ir.unmapped, null, 2)?.slice(0, 3000));

  const outPath = 'C:/Users/CHAITA~1/AppData/Local/Temp/claude/C--Users-ChaitanyaMalle-Studio-Enterprise-Studio-Enterprise/53707df7-aa24-452f-83b4-b9362118e598/scratchpad/workmate_full_ir.json';
  try {
    writeFileSync(outPath, JSON.stringify(row, null, 2));
    console.log(`\nFull raw record (all topics' raw YAML, full unmapped, etc.) written to: ${outPath}`);
  } catch (e) {
    console.log(`\n(could not write full dump file: ${(e as Error).message})`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
