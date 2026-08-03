/**
 * DIAGNOSTIC — compile REAL cached topics with Backend A and print the result.
 *
 * The true test of the compiler: run it over the tenant's actual topics and read
 * the procedures it produces. READ-ONLY (agentIRCache).
 *
 *   npx tsx src/_diag_compile_topics.ts                 # all non-system topics
 *   npx tsx src/_diag_compile_topics.ts "compete"       # filter by agent/topic name
 */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import { config } from './config.js';
import { parseTopicGraph } from './services/topicGraph.js';
import { compileTopic, type CompiledTopic } from './services/topicCompiler.js';
import type { AgentIR } from './types.js';

const FILTER = (process.argv[2] || '').toLowerCase();

async function main(): Promise<void> {
  await connectMongo();
  const docs = await getDb(config.CSGE_DB)
    .collection<{ ir: AgentIR }>('agentIRCache')
    .find({}, { projection: { ir: 1 } })
    .toArray();

  const tally = { full: 0, high: 0, partial: 0, deterministic: 0, printed: 0 };
  const line = '─'.repeat(70);

  for (const { ir } of docs) {
    if (!ir?.topics) continue;
    const nameById = new Map(ir.topics.map((t) => [t.id, t.name]));

    for (const t of ir.topics) {
      if (t.isSystem) continue;
      if (FILTER && !`${ir.name} ${t.name}`.toLowerCase().includes(FILTER)) continue;

      const graph = t.graph ?? parseTopicGraph(t.raw ?? null);
      const c: CompiledTopic = compileTopic(graph, {
        resolveTopicName: (ref) => nameById.get(ref),
        aiPromptFor: () => t.aiPrompt,
      });

      tally[c.fidelity]++;
      if (c.determinism === 'requires-deterministic') tally.deterministic++;
      tally.printed++;

      console.log(`\n${line}`);
      console.log(` ${ir.name}  ›  ${t.name}`);
      console.log(`   trigger: ${t.triggerPhrases.slice(0, 4).join(' · ') || '(no phrases)'}`);
      console.log(`   fidelity: ${c.fidelity}   determinism: ${c.determinism}   nodes: ${graph?.nodes.length ?? 0}`);
      console.log(line);
      console.log(c.procedure || '   (empty — nothing to compile)');
      if (c.notes.length) {
        console.log('   ⚠ notes:');
        for (const n of c.notes) console.log(`     · ${n}`);
      }
    }
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log(` Compiled ${tally.printed} topic(s):  full=${tally.full}  high=${tally.high}  partial=${tally.partial}  ·  need-deterministic=${tally.deterministic}`);
  console.log('═'.repeat(70) + '\n');
  process.exit(0);
}

main().catch((e) => {
  console.error('DIAG FAILED:', (e as Error).message);
  process.exit(1);
});
