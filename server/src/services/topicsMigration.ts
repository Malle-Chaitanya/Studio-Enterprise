/**
 * Backend B — Topics phase: AgentIR topics → Capability → Connected-Agent plan.
 *
 * This is the layer mapper.ts defers to ("Topic/AI-Builder logic is migrated
 * separately in the topics phase (built next)"). It does NOT fold topics into
 * the agent instruction; it produces the structured destination plan we agreed:
 *
 *     Copilot Topic  →  Capability (business unit)  →  Connected Agent (domain)
 *
 * Design (matches docs/architecture/topics-migration-production.md):
 *   • Capability, not topic, is the unit. Topics are Copilot implementation
 *     details; capabilities are business concepts the customer understands.
 *   • System topics (greeting/fallback/escalate) → root-agent config, never a
 *     connected agent.
 *   • Domain-grouped by default (a client-approved knob): related capabilities
 *     cluster into one connected agent instead of one-agent-per-topic.
 *   • Honesty over overclaiming: every capability carries fidelity, determinism,
 *     named lossy items, and required manual actions. Nothing is silently
 *     softened — a side-effecting action is flagged as needing a rebuilt tool.
 *   • Provenance: every capability traces back to its source topic id + node
 *     stats.
 *
 * PURE: no I/O, no framework, no LLM. Fully unit-testable
 * (see _test_topics_migration.ts). Deploying the plan to Gemini connected agents
 * is a separate, API-dependent step (that surface shifts — not fabricated here).
 */
import type { AgentIR, TopicIR } from '../types.js';
import { parseTopicGraph, graphStats, type NodeKind, type TopicGraph } from './topicGraph.js';
import { compileTopic, type CompileContext, type Determinism, type Fidelity } from './topicCompiler.js';
import { analyzeState } from './stateThreading.js';

// ── Public types ─────────────────────────────────────────────────────────────

export type Granularity = 'monolithic' | 'domain-grouped' | 'per-capability';
export type CapabilityClass = 'system' | 'qa' | 'transactional' | 'orchestration';

export interface CapabilityTool {
  /** Source ref (connector name, http url, ai-builder model id). */
  ref: string;
  kind: 'connector' | 'http' | 'ai-builder';
  /**
   * True when this must be rebuilt as a deterministic Cloud Workflow / function
   * (side-effecting connector/http). ai-builder becomes model reasoning, not a
   * workflow, so it is false.
   */
  requiresWorkflow: boolean;
}

/** A business capability derived from one source topic. */
export interface Capability {
  /** Source topic id — provenance. */
  id: string;
  /** Human capability name (the topic name). */
  name: string;
  description?: string;
  classification: CapabilityClass;
  triggers: string[];
  /** Compiled behavioral guidance (from topicCompiler) — the "how". */
  procedure: string;
  tools: CapabilityTool[];
  usesKnowledge: boolean;
  fidelity: Fidelity;
  determinism: Determinism;
  domain: string;
  /** Inputs the capability needs supplied (globals / topic params) — for tool/agent params. */
  stateIn: string[];
  /** Values the capability produces (written locally) — consumable downstream. */
  stateOut: string[];
  /** Variables read with no resolvable writer — dead references, flagged for review. */
  unresolvedState: string[];
  lossyItems: string[];
  manualActions: string[];
  needsHumanReview: boolean;
  provenance: { topicId: string; topicName: string; nodeCount: number; stats: Record<NodeKind, number> };
}

/** A domain-scoped connected agent grouping several capabilities. */
export interface ConnectedAgentPlan {
  name: string;
  domain: string;
  capabilities: Capability[];
  /** Deduped union of the group's tools (each → a Gemini tool / Cloud Workflow). */
  tools: CapabilityTool[];
  starterPrompts: string[];
  usesKnowledge: boolean;
}

export interface TopicsMigrationPlan {
  rootAgentName: string;
  granularity: Granularity;
  /** Greeting/fallback/escalate → root-agent config, NOT connected agents. */
  systemCapabilities: Capability[];
  connectedAgents: ConnectedAgentPlan[];
  summary: {
    topics: number;
    capabilities: number;
    connectedAgents: number;
    byClass: Record<CapabilityClass, number>;
    byFidelity: Record<Fidelity, number>;
    deterministicTools: number;
    needsReview: number;
    /** Capabilities with at least one unresolved input variable (dead reference). */
    unresolvedInputs: number;
  };
}

export interface PlanOptions {
  /** Grouping strategy. Default 'domain-grouped'. */
  granularity?: Granularity;
}

// ── Graph scan ───────────────────────────────────────────────────────────────

interface Scan {
  childGotos: number;
  tools: CapabilityTool[];
  usesKnowledge: boolean;
}

/** Pull the tool/routing/knowledge signals out of a parsed topic graph. */
function scanGraph(graph: TopicGraph): Scan {
  const tools: CapabilityTool[] = [];
  let childGotos = 0;
  let usesKnowledge = false;
  for (const n of graph.nodes) {
    if (n.kind === 'goto' && n.dependencyType === 'child-agent') childGotos++;
    if (n.kind === 'action') {
      if (n.dependencyType === 'connector' || n.dependencyType === 'http') {
        tools.push({ ref: n.ref ?? n.rawKind, kind: n.dependencyType, requiresWorkflow: true });
      } else if (n.dependencyType === 'ai-builder-model') {
        tools.push({ ref: n.ref ?? '(model)', kind: 'ai-builder', requiresWorkflow: false });
      } else if (n.dependencyType === 'knowledge') {
        usesKnowledge = true;
      }
    }
  }
  return { childGotos, tools, usesKnowledge };
}

/**
 * Classify a topic into a business-capability bucket. Order matters: system
 * wins first; a side effect makes it transactional regardless of shape; pure
 * routing (≥2 child-topic calls, no tools) is orchestration; everything else is
 * conversational Q&A.
 */
function classify(topic: TopicIR, scan: Scan, determinism: Determinism): CapabilityClass {
  if (topic.isSystem) return 'system';
  if (determinism === 'requires-deterministic' || scan.tools.some((t) => t.requiresWorkflow)) return 'transactional';
  if (scan.childGotos >= 2 && scan.tools.length === 0) return 'orchestration';
  return 'qa';
}

// ── Capability build ─────────────────────────────────────────────────────────

function buildCapability(topic: TopicIR, ctx: CompileContext): Capability {
  const graph = topic.graph ?? parseTopicGraph(topic.raw);
  const compiled = compileTopic(graph, ctx);
  const scan = scanGraph(graph);
  const state = analyzeState(graph);
  const classification = classify(topic, scan, compiled.determinism);

  const lossyItems = [...compiled.notes, ...state.notes];
  if (compiled.determinism === 'requires-deterministic') {
    lossyItems.push('Deterministic ordering/branching becomes model-guided in a generative agent — not guaranteed exact.');
  }

  const manualActions: string[] = [];
  for (const t of scan.tools) {
    if (t.requiresWorkflow) {
      manualActions.push(`Rebuild "${t.ref}" as a Cloud Workflow / tool and reconnect its auth in the destination.`);
    } else if (t.kind === 'ai-builder') {
      manualActions.push(`Validate the AI reasoning step "${t.ref}" behaves equivalently.`);
    }
  }
  if (state.unresolved.length) {
    manualActions.push(
      `Confirm the source of input(s) ${state.unresolved.map((v) => v.name).join(', ')} — read but never set in this capability.`,
    );
  }

  const needsHumanReview =
    compiled.fidelity === 'partial' ||
    compiled.determinism === 'requires-deterministic' ||
    classification === 'orchestration' ||
    state.unresolved.length > 0;

  return {
    id: topic.id,
    name: topic.name,
    description: topic.modelDescription || topic.summary || undefined,
    classification,
    triggers: [...topic.triggerPhrases],
    procedure: compiled.procedure,
    tools: dedupeTools(scan.tools),
    usesKnowledge: scan.usesKnowledge,
    fidelity: compiled.fidelity,
    determinism: compiled.determinism,
    domain: '', // assigned during grouping
    stateIn: state.stateIn.map((v) => v.name),
    stateOut: state.stateOut.map((v) => v.name),
    unresolvedState: state.unresolved.map((v) => v.name),
    lossyItems: [...new Set(lossyItems)],
    manualActions: [...new Set(manualActions)],
    needsHumanReview,
    provenance: {
      topicId: topic.id,
      topicName: topic.name,
      nodeCount: graph.nodes.length,
      stats: graphStats(graph),
    },
  };
}

function dedupeTools(tools: CapabilityTool[]): CapabilityTool[] {
  const seen = new Map<string, CapabilityTool>();
  for (const t of tools) seen.set(`${t.kind}:${t.ref}`, t);
  return [...seen.values()];
}

// ── Domain clustering (heuristic — reported as such) ─────────────────────────

const STOP = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'with', 'my', 'me', 'is', 'on', 'in',
  'get', 'set', 'new', 'handle', 'topic', 'agent', 'user', 'ask', 'show', 'run',
]);

/** Significant tokens from a name: split camelCase + non-alphanum, drop stopwords. */
function tokensOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/** Union-find for clustering capabilities that share domain signals. */
class DSU {
  private parent: number[];
  constructor(n: number) {
    this.parent = Array.from({ length: n }, (_, i) => i);
  }
  find(x: number): number {
    while (this.parent[x] !== x) {
      this.parent[x] = this.parent[this.parent[x]];
      x = this.parent[x];
    }
    return x;
  }
  union(a: number, b: number): void {
    this.parent[this.find(a)] = this.find(b);
  }
}

/**
 * Cluster capabilities into domains by shared significant name tokens. This is a
 * heuristic (name-based); the grouping is a recommendation the client can
 * override via the granularity knob — never a silent decision.
 */
function assignDomains(caps: Capability[], rootAgentName: string): void {
  const dsu = new DSU(caps.length);
  const tokenLists = caps.map((c) => tokensOf(c.name));

  // Union any two capabilities that share a token.
  const tokenToFirst = new Map<string, number>();
  tokenLists.forEach((toks, i) => {
    for (const t of toks) {
      const first = tokenToFirst.get(t);
      if (first === undefined) tokenToFirst.set(t, i);
      else dsu.union(first, i);
    }
  });

  // Name each cluster by its most frequent shared token.
  const clusters = new Map<number, number[]>();
  caps.forEach((_, i) => {
    const r = dsu.find(i);
    (clusters.get(r) ?? clusters.set(r, []).get(r)!).push(i);
  });

  for (const members of clusters.values()) {
    const freq = new Map<string, number>();
    for (const i of members) for (const t of tokenLists[i]) freq.set(t, (freq.get(t) ?? 0) + 1);
    let top: string | undefined;
    let topN = 0;
    for (const [t, n] of freq) if (n > topN) ((top = t), (topN = n));
    const domain = top ? top[0].toUpperCase() + top.slice(1) : rootAgentName;
    for (const i of members) caps[i].domain = domain;
  }
}

// ── Grouping into connected agents ───────────────────────────────────────────

function groupConnectedAgents(caps: Capability[], granularity: Granularity, rootAgentName: string): ConnectedAgentPlan[] {
  if (caps.length === 0) return [];

  const make = (name: string, domain: string, members: Capability[]): ConnectedAgentPlan => ({
    name,
    domain,
    capabilities: members,
    tools: dedupeTools(members.flatMap((c) => c.tools)),
    starterPrompts: [...new Set(members.flatMap((c) => c.triggers).filter(Boolean))].slice(0, 6),
    usesKnowledge: members.some((c) => c.usesKnowledge),
  });

  if (granularity === 'monolithic') {
    return [make(rootAgentName, rootAgentName, caps)];
  }
  if (granularity === 'per-capability') {
    return caps.map((c) => make(c.name, c.domain || c.name, [c]));
  }
  // domain-grouped (default)
  const byDomain = new Map<string, Capability[]>();
  for (const c of caps) (byDomain.get(c.domain) ?? byDomain.set(c.domain, []).get(c.domain)!).push(c);
  return [...byDomain.entries()].map(([domain, members]) => make(domain, domain, members));
}

// ── Public entry point ───────────────────────────────────────────────────────

export function planTopicsMigration(ir: AgentIR, opts: PlanOptions = {}): TopicsMigrationPlan {
  const granularity = opts.granularity ?? 'domain-grouped';

  // Compile context: resolve cross-topic goto targets to names, and feed the
  // topic's real AI Builder prompt to its ai-builder action nodes.
  const nameById = new Map(ir.topics.map((t) => [t.id, t.name]));
  const promptById = new Map(ir.topics.map((t) => [t.id, t.aiPrompt]));

  const capabilities: Capability[] = ir.topics.map((topic) => {
    const ctx: CompileContext = {
      resolveTopicName: (ref) => nameById.get(ref),
      aiPromptFor: () => promptById.get(topic.id) || topic.aiPrompt,
    };
    return buildCapability(topic, ctx);
  });

  const systemCapabilities = capabilities.filter((c) => c.classification === 'system');
  const businessCaps = capabilities.filter((c) => c.classification !== 'system');

  if (granularity === 'domain-grouped') assignDomains(businessCaps, ir.name);

  const connectedAgents = groupConnectedAgents(businessCaps, granularity, ir.name);

  // ── Summary ────────────────────────────────────────────────────────────────
  const byClass: Record<CapabilityClass, number> = { system: 0, qa: 0, transactional: 0, orchestration: 0 };
  const byFidelity: Record<Fidelity, number> = { full: 0, high: 0, partial: 0 };
  let deterministicTools = 0;
  let needsReview = 0;
  let unresolvedInputs = 0;
  for (const c of capabilities) {
    byClass[c.classification]++;
    byFidelity[c.fidelity]++;
    deterministicTools += c.tools.filter((t) => t.requiresWorkflow).length;
    if (c.needsHumanReview) needsReview++;
    if (c.unresolvedState.length) unresolvedInputs++;
  }

  return {
    rootAgentName: ir.name,
    granularity,
    systemCapabilities,
    connectedAgents,
    summary: {
      topics: ir.topics.length,
      capabilities: capabilities.length,
      connectedAgents: connectedAgents.length,
      byClass,
      byFidelity,
      deterministicTools,
      needsReview,
      unresolvedInputs,
    },
  };
}
