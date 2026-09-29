/** LIVE Dataverse extraction of the WorkMate agent, right now, bypassing the
 *  Mongo stagedAgents cache entirely. Read-only against Dataverse.
 *  npx tsx src/spikes/_diag_live_extract_workmate.ts */
import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

const TARGET_BOT_ID = 'ca01dff9-279d-f111-b8de-0022480b19e9';

async function main() {
  await connectMongo();
  const sessions = (await getDb()
    .collection('migrationSessions')
    .find({ tenantId: { $exists: true }, environments: { $exists: true, $ne: [] } })
    .sort({ $natural: -1 })
    .limit(10)
    .toArray()) as unknown as Session[];

  if (!sessions.length) throw new Error('no migrationSessions with cached environments found');

  for (const s of sessions) {
    for (const env of s.environments ?? []) {
      let token: string;
      try {
        token = await clientCredsToken(s.tenantId ?? '', env.url);
      } catch (e) {
        console.log(`skip env ${env.name} (${env.url}): token failed — ${(e as Error).message}`);
        continue;
      }
      let bots;
      try {
        bots = await listBots(env.url, token);
      } catch (e) {
        console.log(`skip env ${env.name} (${env.url}): listBots failed — ${(e as Error).message}`);
        continue;
      }
      const bot = bots.find((b) => b.botid === TARGET_BOT_ID || /workmate/i.test(b.name));
      if (!bot) { console.log(`env ${env.name}: ${bots.length} bot(s), WorkMate not found here`); continue; }

      console.log(`\nFOUND live in env "${env.name}" (${env.url}) — extracting fresh right now...\n`);
      const ir = await extractAgent(env.url, token, bot);

      console.log(`name: ${ir.name}`);
      console.log(`sourceId: ${ir.sourceId}`);
      console.log(`\ndescription: ${ir.description}`);
      console.log(`\ninstructions:\n${ir.instructions}`);
      console.log(`\ncapabilities: ${JSON.stringify(ir.capabilities)}`);
      console.log(`starterPrompts: ${JSON.stringify(ir.starterPrompts)}`);

      console.log(`\n--- topics (${ir.topics?.length ?? 0}) ---`);
      for (const t of ir.topics ?? []) {
        console.log(`  - ${t.name}${t.isSystem ? ' [system]' : ''}${t.isChildAgent ? ' [child-agent]' : ''} (${t.triggerPhrases?.length ?? 0} triggers)`);
      }

      console.log(`\n--- knowledge sources (${ir.knowledgeSources?.length ?? 0}) ---`);
      for (const k of (ir.knowledgeSources ?? []) as any[]) {
        console.log(`  - ${k.kind ?? k.name ?? JSON.stringify(k).slice(0, 100)}`);
      }

      console.log(`\n--- agent tools / connectors (${ir.agentTools?.length ?? 0}) ---`);
      for (const tool of (ir.agentTools ?? []) as any[]) {
        console.log(`  - connectorId=${tool.connectorId} operationId=${tool.operationId} name=${tool.name ?? ''}`);
      }

      console.log(`\n--- permissions ---`);
      console.log(JSON.stringify(ir.permissions, null, 2));

      console.log(`\n--- unmapped ---`);
      console.log(JSON.stringify(ir.unmapped, null, 2));

      const outPath = 'C:/Users/CHAITA~1/AppData/Local/Temp/claude/C--Users-ChaitanyaMalle-Studio-Enterprise-Studio-Enterprise/53707df7-aa24-452f-83b4-b9362118e598/scratchpad/workmate_live_ir.json';
      writeFileSync(outPath, JSON.stringify(ir, null, 2));
      console.log(`\nFull live-extracted IR (all raw topic YAML, full unmapped) written to: ${outPath}`);
      process.exit(0);
    }
  }
  console.log('\nWorkMate not found live in any cached environment across recent sessions.');
  process.exit(1);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
