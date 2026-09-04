/**
 * Read-only: fetch WorkMate's CURRENT real content directly from Copilot
 * Studio/Dataverse (not the possibly-stale agentIRCache) — topics, knowledge
 * sources, and tools/connectors as they exist right now. Used to ground a
 * recommendation for what real child agent to build on WorkMate next,
 * instead of guessing from an old cached extraction.
 *
 * Run: cd server && npx tsx src/spikes/_diag_fetch_workmate_live_current.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.tenantId || !s.environments?.length) throw new Error('no session with tenantId + environments found');

  console.log(`checking ${s.environments.length} environment(s) on this session...\n`);
  for (const env of s.environments) {
    let bots;
    try {
      const token = await clientCredsToken(s.tenantId, env.url);
      bots = await listBots(env.url, token);
    } catch (e) {
      console.log(`env "${env.name}": FAILED (${(e as Error).message}) — skipping`);
      continue;
    }
    const match = bots.find((b) => b.name === 'WorkMate');
    if (!match) {
      console.log(`env "${env.name}" (${bots.length} bot(s)): no WorkMate here`);
      continue;
    }
    const token = await clientCredsToken(s.tenantId, env.url);
    console.log(`found WorkMate in env "${env.name}" (${env.url})\n`);
    const ir = await extractAgent(env.url, token, match);
    console.log('=== LIVE, CURRENT WorkMate content ===\n');
    console.log('name:', ir.name);
    console.log('description:', ir.description);
    console.log('\ninstructions:\n', ir.instructions);
    console.log(`\ntopics (${ir.topics.length}):`);
    for (const t of ir.topics) console.log(`  - ${t.name}${t.isChildAgent ? ' [CHILD AGENT, id=' + t.id + ']' : ''}${t.summary ? ': ' + t.summary.slice(0, 100) : ''}`);
    console.log(`\nknowledge sources (${ir.knowledgeSources.length}):`);
    for (const k of ir.knowledgeSources) console.log(`  - ${k.name} (${k.kind})`);
    console.log(`\nagent tools (${ir.agentTools?.length ?? 0}):`);
    for (const tool of ir.agentTools ?? []) console.log(`  - ${tool.name}${tool.childAgentTopicId ? ' [owned by child agent ' + tool.childAgentTopicId + ']' : ''} (${tool.kind}, operationId=${tool.operationId ?? 'n/a'})`);
    process.exit(0);
  }
  console.log('\nWorkMate not found in any environment on this session.');
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
