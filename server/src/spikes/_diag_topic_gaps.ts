/**
 * DIAGNOSTIC — why topics land in no-graph / complex (parser-coverage gaps).
 *
 * Converts the corpus spike's "20.8% manual" into an actionable list:
 *   1. Which AdaptiveDialog `rawKind`s are unrecognized (→ add to KIND_MAP)?
 *   2. Which topics produced no graph, and why (empty raw vs parse error)?
 *
 * READ-ONLY. Same source as the corpus spike (agentIRCache).
 *
 *   npx tsx src/spikes/_diag_topic_gaps.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';
import { parseTopicGraph } from '../services/topicGraph.js';
import type { AgentIR } from '../types.js';

async function main(): Promise<void> {
  await connectMongo();
  const docs = await getDb(config.CSGE_DB)
    .collection<{ ir: AgentIR }>('agentIRCache')
    .find({}, { projection: { ir: 1 } })
    .toArray();

  const unknownKinds = new Map<string, number>(); // rawKind → count
  const unknownExamples = new Map<string, string>(); // rawKind → "topic · agent"
  const noGraph: { agent: string; topic: string; reason: string; rawLen: number }[] = [];

  for (const { ir } of docs) {
    if (!ir?.topics) continue;
    for (const t of ir.topics) {
      const graph = t.graph ?? parseTopicGraph(t.raw ?? null);
      if (!graph || graph.parseError || graph.nodes.length === 0) {
        const reason = graph?.parseError
          ? `parse error: ${graph.parseError}`
          : !t.raw || !t.raw.trim()
            ? 'empty raw YAML'
            : 'parsed but 0 nodes (trigger-only / unrecognized structure)';
        noGraph.push({ agent: ir.name, topic: t.name, reason, rawLen: (t.raw ?? '').length });
        continue;
      }
      for (const n of graph.nodes) {
        if (n.kind === 'unknown') {
          unknownKinds.set(n.rawKind, (unknownKinds.get(n.rawKind) ?? 0) + 1);
          if (!unknownExamples.has(n.rawKind)) unknownExamples.set(n.rawKind, `${t.name} · ${ir.name}`);
        }
      }
    }
  }

  const line = '─'.repeat(64);
  console.log(`\n${line}\n UNRECOGNIZED node kinds (add these to KIND_MAP)\n${line}`);
  if (!unknownKinds.size) {
    console.log(' (none — every node kind is mapped)');
  } else {
    [...unknownKinds.entries()]
      .sort((a, b) => b[1] - a[1])
      .forEach(([k, c]) => console.log(` ${String(c).padStart(3)}×  ${k.padEnd(32)}  e.g. ${unknownExamples.get(k)}`));
  }

  console.log(`\n${line}\n NO-GRAPH topics (${noGraph.length}) — why they produced nothing\n${line}`);
  for (const g of noGraph) {
    console.log(` [rawLen ${String(g.rawLen).padStart(5)}]  ${g.reason.padEnd(40)}  ${g.topic} · ${g.agent}`);
  }
  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error('DIAG FAILED:', (e as Error).message);
  process.exit(1);
});
