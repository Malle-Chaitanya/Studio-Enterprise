/**
 * SPIKE #3 — Topic corpus distribution.
 *
 * Answers the go/no-go question that gates the topic-migration compiler:
 *   "Of all real topics in the tenant, what % does Backend A (graph → instruction
 *    procedure) cover on its own, and how many actually need Backend C (a
 *    deterministic tool) or manual review?"
 *
 * READ-ONLY. Reads every cached AgentIR from Mongo (agentIRCache), classifies
 * each topic from its behavior graph, and prints a distribution. No Dataverse,
 * no Gemini, no writes.
 *
 *   npx tsx src/spikes/_spike_topic_corpus.ts
 *
 * The classifier below (classifyTopic) is written as a PURE function on purpose:
 * it is the seed of the Layer-2 TopicProfile analysis, not throwaway spike code.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';
import { parseTopicGraph, type TopicGraph, type NodeKind } from '../services/topicGraph.js';
import type { AgentIR, TopicIR } from '../types.js';

// ── Classification model ────────────────────────────────────────────────────

/**
 * One primary bucket per topic (mutually exclusive, by precedence) + the
 * cross-cutting flags that drive fidelity/determinism verdicts. Precedence runs
 * most-constraining first, so a side-effecting topic is never miscounted as
 * "branching" just because it also has a condition.
 */
type Bucket =
  | 'system' // isSystem → folds into agent-level behavior, not a procedure
  | 'no-graph' // couldn't parse a graph (raw missing / parse error)
  | 'complex' // unknown nodes or 20+ nodes → Manual review
  | 'side-effecting' // connector/http write → Backend C (deterministic)
  | 'nested' // calls another topic → Backend A via inlining
  | 'ai-builder' // AI Builder model → Backend A, reasoning replaced (partial)
  | 'branching' // conditions/loops, no side effects → Backend A (soft determinism)
  | 'linear' // question/setVar chain → Backend A
  | 'echo'; // messages only → Backend A trivial (FAQ/greeting-style)

interface TopicProfileFacts {
  bucket: Bucket;
  nodeCount: number;
  // cross-cutting flags (a topic can carry several)
  hasSideEffects: boolean; // connector | http action
  hasLoops: boolean;
  hasCrossTopicCalls: boolean;
  hasAiBuilder: boolean;
  hasUnknown: boolean;
  usesCards: boolean;
  conditionCount: number;
}

/** Which Gemini backend a bucket maps to, for the headline coverage number. */
const BACKEND_OF: Record<Bucket, 'A' | 'C' | 'manual' | 'n/a'> = {
  echo: 'A',
  linear: 'A',
  branching: 'A',
  nested: 'A',
  'ai-builder': 'A',
  'side-effecting': 'C',
  complex: 'manual',
  system: 'n/a', // handled at agent level (greeting/escalate/error)
  'no-graph': 'manual',
};

/**
 * PURE: classify one topic from its (already-parsed) graph. This is the exact
 * logic the Layer-2 analyzer will use — kept side-effect-free and framework-free
 * so it can move into services/topicProfile.ts unchanged.
 */
export function classifyTopic(t: TopicIR, graph: TopicGraph | undefined): TopicProfileFacts {
  const base = {
    nodeCount: graph?.nodes.length ?? 0,
    hasSideEffects: false,
    hasLoops: false,
    hasCrossTopicCalls: false,
    hasAiBuilder: Boolean(t.usesAiBuilder),
    hasUnknown: false,
    usesCards: Boolean(t.usesAdaptiveCards),
    conditionCount: 0,
  };

  if (t.isSystem) return { ...base, bucket: 'system' };
  if (!graph || graph.parseError || graph.nodes.length === 0) return { ...base, bucket: 'no-graph' };

  let questionOrSetVar = false;
  let messageCount = 0;
  for (const n of graph.nodes) {
    switch (n.kind) {
      case 'action':
        if (n.dependencyType === 'connector' || n.dependencyType === 'http') base.hasSideEffects = true;
        if (n.dependencyType === 'ai-builder-model') base.hasAiBuilder = true;
        break;
      case 'goto':
        if (n.dependencyType === 'child-agent') base.hasCrossTopicCalls = true;
        break;
      case 'loop':
        base.hasLoops = true;
        break;
      case 'condition':
        base.conditionCount += n.branches?.length ?? 1;
        break;
      case 'question':
      case 'setVar':
        questionOrSetVar = true;
        break;
      case 'message':
        messageCount++;
        break;
      case 'unknown':
        base.hasUnknown = true;
        break;
    }
  }

  // Precedence: most-constraining first.
  let bucket: Bucket;
  if (base.hasUnknown || base.nodeCount > 20) bucket = 'complex';
  else if (base.hasSideEffects) bucket = 'side-effecting';
  else if (base.hasCrossTopicCalls) bucket = 'nested';
  else if (base.hasAiBuilder) bucket = 'ai-builder';
  else if (base.conditionCount > 0 || base.hasLoops) bucket = 'branching';
  else if (questionOrSetVar) bucket = 'linear';
  else if (messageCount > 0) bucket = 'echo';
  else bucket = 'complex'; // nodes present but none recognized as behavior

  return { ...base, bucket };
}

// ── Report ──────────────────────────────────────────────────────────────────

function pct(n: number, total: number): string {
  return total ? `${((100 * n) / total).toFixed(1)}%` : '0.0%';
}

function bar(n: number, total: number, width = 24): string {
  const filled = total ? Math.round((width * n) / total) : 0;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

async function main(): Promise<void> {
  await connectMongo();
  const docs = await getDb(config.CSGE_DB)
    .collection<{ ir: AgentIR }>('agentIRCache')
    .find({}, { projection: { ir: 1 } })
    .toArray();

  if (!docs.length) {
    console.log('\nNo cached AgentIR found in agentIRCache. Run an extraction (or dry-run) first, then re-run this.\n');
    process.exit(0);
  }

  const buckets: Record<Bucket, number> = {
    echo: 0, linear: 0, branching: 0, nested: 0, 'ai-builder': 0,
    'side-effecting': 0, complex: 0, system: 0, 'no-graph': 0,
  };
  const nodeKindTotals: Record<NodeKind, number> = {
    message: 0, question: 0, condition: 0, loop: 0, setVar: 0, action: 0, goto: 0, end: 0, unknown: 0,
  };
  const flags = { sideEffects: 0, loops: 0, crossTopic: 0, aiBuilder: 0, cards: 0, unknown: 0 };

  let agents = 0;
  let topics = 0;
  let customTopics = 0; // non-system
  let totalNodes = 0;
  const heaviest: { agent: string; topic: string; nodes: number; bucket: Bucket }[] = [];

  for (const { ir } of docs) {
    if (!ir?.topics) continue;
    agents++;
    for (const t of ir.topics) {
      topics++;
      const graph = t.graph ?? parseTopicGraph(t.raw ?? null);
      const p = classifyTopic(t, graph);
      buckets[p.bucket]++;
      if (!t.isSystem) customTopics++;

      if (graph?.nodes) {
        totalNodes += graph.nodes.length;
        for (const n of graph.nodes) nodeKindTotals[n.kind]++;
      }
      if (p.hasSideEffects) flags.sideEffects++;
      if (p.hasLoops) flags.loops++;
      if (p.hasCrossTopicCalls) flags.crossTopic++;
      if (p.hasAiBuilder) flags.aiBuilder++;
      if (p.usesCards) flags.cards++;
      if (p.hasUnknown) flags.unknown++;

      heaviest.push({ agent: ir.name, topic: t.name, nodes: p.nodeCount, bucket: p.bucket });
    }
  }

  // Backend coverage headline (denominator = non-system topics — the ones that
  // become procedures/tools; system topics fold into agent-level behavior).
  const backendCount = { A: 0, C: 0, manual: 0 };
  for (const b of Object.keys(buckets) as Bucket[]) {
    const target = BACKEND_OF[b];
    if (target === 'A') backendCount.A += buckets[b];
    else if (target === 'C') backendCount.C += buckets[b];
    else if (target === 'manual') backendCount.manual += buckets[b];
  }
  const mappable = backendCount.A + backendCount.C + backendCount.manual; // = non-system

  const line = '─'.repeat(60);
  console.log(`\n${line}\n TOPIC CORPUS DISTRIBUTION\n${line}`);
  console.log(` Agents (cached IR): ${agents}`);
  console.log(` Topics total: ${topics}  ·  custom (non-system): ${customTopics}  ·  system: ${buckets.system}`);
  console.log(` Avg nodes/topic: ${topics ? (totalNodes / topics).toFixed(1) : 0}  ·  total nodes: ${totalNodes}`);

  console.log(`\n${line}\n HEADLINE — non-system topic coverage (n=${mappable})\n${line}`);
  console.log(` Backend A (instruction/inline)  ${bar(backendCount.A, mappable)}  ${backendCount.A}  ${pct(backendCount.A, mappable)}`);
  console.log(` Backend C (deterministic tool)  ${bar(backendCount.C, mappable)}  ${backendCount.C}  ${pct(backendCount.C, mappable)}`);
  console.log(` Manual review                   ${bar(backendCount.manual, mappable)}  ${backendCount.manual}  ${pct(backendCount.manual, mappable)}`);
  console.log(`\n  → MVP (Backend A only) covers ${pct(backendCount.A, mappable)} of real topics.`);

  console.log(`\n${line}\n BY BUCKET (all ${topics} topics)\n${line}`);
  const order: Bucket[] = ['echo', 'linear', 'branching', 'nested', 'ai-builder', 'side-effecting', 'complex', 'no-graph', 'system'];
  for (const b of order) {
    const backend = BACKEND_OF[b];
    console.log(` ${b.padEnd(16)} ${bar(buckets[b], topics)}  ${String(buckets[b]).padStart(4)}  ${pct(buckets[b], topics).padStart(6)}  →${backend}`);
  }

  console.log(`\n${line}\n CROSS-CUTTING FLAGS (fidelity/determinism risks)\n${line}`);
  console.log(` side-effecting (connector/http): ${flags.sideEffects}  ← must be Backend C, never soft`);
  console.log(` loops:                           ${flags.loops}`);
  console.log(` cross-topic calls (nesting):     ${flags.crossTopic}  ← need cycle-safe inlining`);
  console.log(` AI Builder models:               ${flags.aiBuilder}  ← reasoning replaced by Gemini`);
  console.log(` Adaptive Cards:                  ${flags.cards}  ← render to markdown/rich`);
  console.log(` unknown node kinds:              ${flags.unknown}  ← preserved raw, manual`);

  console.log(`\n${line}\n NODE-KIND HISTOGRAM (all parsed nodes)\n${line}`);
  for (const k of Object.keys(nodeKindTotals) as NodeKind[]) {
    console.log(` ${k.padEnd(10)} ${bar(nodeKindTotals[k], totalNodes)}  ${nodeKindTotals[k]}`);
  }

  console.log(`\n${line}\n TOP 12 HEAVIEST TOPICS (compiler stress cases)\n${line}`);
  heaviest.sort((a, b) => b.nodes - a.nodes);
  for (const h of heaviest.slice(0, 12)) {
    console.log(` ${String(h.nodes).padStart(3)} nodes  [${h.bucket.padEnd(14)}]  ${h.topic}  ·  ${h.agent}`);
  }
  console.log('');
  process.exit(0);
}

main().catch((e) => {
  console.error('SPIKE FAILED:', (e as Error).message);
  process.exit(1);
});
