/**
 * State threading — the deterministic variable read/write analysis that pure
 * templating misses (AgentIR v2 §8 / topics-migration-production.md §8).
 *
 * A Copilot topic writes variables (Question → save-as, SetVariable) and reads
 * them later (conditions, message bindings, loop sources). If we translate each
 * node in isolation, the destination gets instructions that reference variables
 * it was never given — behavior breaks. This pass builds the variable dependency
 * graph so synthesis can bind real inputs/outputs and flag dead references
 * HONESTLY instead of silently emitting them.
 *
 * PURE: no I/O, no LLM. Fully unit-testable (see _test_state_threading.ts).
 *
 * Scope of this version (honest about limits):
 *   • Reads are extracted from scope-qualified references (Topic.x / Global.x /
 *     System.x / Bot.x) in condition/setVar expressions, message bindings, and
 *     loop sources — the forms Copilot actually emits.
 *   • Action-node input bindings are NOT in the parsed graph yet, so a connector
 *     input that consumes a variable can't be threaded here; that is noted, not
 *     hidden.
 *   • Cross-topic resolution (a value written in another topic) is left to an
 *     agent-level pass; here a Topic-scoped read with no local writer is treated
 *     as UNRESOLVED (needs review), never silently resolved.
 */
import type { DialogNode, TopicGraph } from './topicGraph.js';

export type VarScope = 'topic' | 'global' | 'system' | 'bot' | 'unknown';
export type VarDirection = 'in' | 'out' | 'local';

export interface StateVar {
  /** Clean variable name, scope prefix stripped (e.g. `Confirm`). */
  name: string;
  scope: VarScope;
  direction: VarDirection;
  /**
   * Destination binding for this variable when it crosses a boundary:
   *   in    → a tool/agent input parameter the caller must supply
   *   out   → a tool/agent output other steps can consume
   *   local → resolved internally (written then read in this topic); no binding
   */
  resolvedParam?: string;
  /** false → the reference could not be resolved to a writer/source → review. */
  resolved: boolean;
  writeNodeIds: string[];
  readNodeIds: string[];
}

export interface StateThreading {
  /** Every distinct variable touched by the topic. */
  vars: StateVar[];
  /** Inputs: read before/without a local write (globals, topic input params). */
  stateIn: StateVar[];
  /** Outputs: written locally (may be consumed downstream or by the caller). */
  stateOut: StateVar[];
  /** Topic-scoped reads with NO writer — dead references, surfaced for review. */
  unresolved: StateVar[];
  /** Human-readable warnings (unresolved reads, un-threadable action inputs…). */
  notes: string[];
}

// ── Variable-reference extraction ────────────────────────────────────────────

const SCOPE_OF: Record<string, VarScope> = {
  topic: 'topic',
  global: 'global',
  system: 'system',
  bot: 'bot',
  conversation: 'system',
};

/** Strip a scope prefix, returning {scope, name}. Bare names default to topic. */
function splitRef(raw: string): { scope: VarScope; name: string } {
  const m = raw.trim().match(/^(?:(Topic|Global|System|Bot|conversation)\.)?([A-Za-z_][A-Za-z0-9_]*)/i);
  if (!m) return { scope: 'unknown', name: raw.trim() };
  const scope = m[1] ? SCOPE_OF[m[1].toLowerCase()] ?? 'unknown' : 'topic';
  return { scope, name: m[2] };
}

/**
 * Pull every scope-qualified variable reference out of an expression or message
 * string: `Topic.x`, `Global.y`, `System.z`, `Bot.w`. We only capture qualified
 * refs — bare identifiers are ambiguous with Power Fx function names and would
 * produce false positives.
 */
function readsIn(text: string | undefined): { scope: VarScope; name: string }[] {
  if (!text) return [];
  const out: { scope: VarScope; name: string }[] = [];
  const re = /\b(Topic|Global|System|Bot|conversation)\.([A-Za-z_][A-Za-z0-9_]*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ scope: SCOPE_OF[m[1].toLowerCase()] ?? 'unknown', name: m[2] });
  return out;
}

// ── The analysis ─────────────────────────────────────────────────────────────

interface Touch {
  scope: VarScope;
  writes: string[];
  reads: string[];
}

/** Collect raw writes/reads per variable name across all nodes. */
function collect(nodes: DialogNode[]): Map<string, Touch> {
  const touches = new Map<string, Touch>();
  const touch = (scope: VarScope, name: string): Touch => {
    const key = name;
    let t = touches.get(key);
    if (!t) touches.set(key, (t = { scope, writes: [], reads: [] }));
    // A qualified scope always wins over a defaulted 'topic'.
    if (scope !== 'topic' && t.scope === 'topic') t.scope = scope;
    return t;
  };

  for (const n of nodes) {
    switch (n.kind) {
      case 'question': {
        if (n.storeIn) {
          const { scope, name } = splitRef(n.storeIn);
          touch(scope, name).writes.push(n.id);
        }
        // The prompt can echo earlier answers via bindings.
        for (const r of readsIn(n.prompt)) touch(r.scope, r.name).reads.push(n.id);
        break;
      }
      case 'setVar': {
        if (n.target) {
          const { scope, name } = splitRef(n.target);
          touch(scope, name).writes.push(n.id);
        }
        for (const r of readsIn(n.expr)) touch(r.scope, r.name).reads.push(n.id);
        break;
      }
      case 'condition': {
        for (const b of n.branches ?? []) for (const r of readsIn(b.expr)) touch(r.scope, r.name).reads.push(n.id);
        break;
      }
      case 'loop': {
        for (const r of readsIn(n.overVar)) touch(r.scope, r.name).reads.push(n.id);
        if (n.itemVar) {
          const { scope, name } = splitRef(n.itemVar);
          touch(scope, name).writes.push(n.id); // item var is written each iteration
        }
        break;
      }
      case 'message': {
        for (const r of readsIn(n.text)) touch(r.scope, r.name).reads.push(n.id);
        break;
      }
      default:
        break;
    }
  }
  return touches;
}

/**
 * Analyze a topic graph's variable flow.
 *
 * Classification per variable:
 *   • written locally & read      → `local`, resolved (internal state)
 *   • written locally, not read   → `out`,   resolved (available downstream)
 *   • read, System-scoped         → `in`,    resolved (runtime-provided)
 *   • read, Global-scoped         → `in`,    resolved (agent/shared state)
 *   • read, Topic/unknown, no writer → `in`, UNRESOLVED (dead ref → review)
 */
export function analyzeState(graph: TopicGraph | undefined): StateThreading {
  const empty: StateThreading = { vars: [], stateIn: [], stateOut: [], unresolved: [], notes: [] };
  if (!graph || !graph.nodes?.length) return empty;

  const touches = collect(graph.nodes);
  const notes: string[] = [];
  const vars: StateVar[] = [];

  for (const [name, t] of touches) {
    const written = t.writes.length > 0;
    const read = t.reads.length > 0;
    let direction: VarDirection;
    let resolved: boolean;
    let resolvedParam: string | undefined;

    if (written && read) {
      direction = 'local';
      resolved = true;
    } else if (written && !read) {
      direction = 'out';
      resolved = true;
      resolvedParam = name;
    } else {
      // read-only (no local writer)
      direction = 'in';
      if (t.scope === 'system') {
        resolved = true; // runtime-provided (User.*, Conversation.*, …)
      } else if (t.scope === 'global' || t.scope === 'bot') {
        resolved = true; // agent/shared state
        resolvedParam = name;
      } else {
        resolved = false; // Topic/unknown read with no writer → dead reference
        resolvedParam = name;
      }
    }

    vars.push({ name, scope: t.scope, direction, resolvedParam, resolved, writeNodeIds: t.writes, readNodeIds: t.reads });
  }

  const stateIn = vars.filter((v) => v.direction === 'in');
  const stateOut = vars.filter((v) => v.direction === 'out');
  const unresolved = vars.filter((v) => !v.resolved);

  if (unresolved.length) {
    notes.push(
      `${unresolved.length} variable read(s) with no writer in this topic ` +
        `(${unresolved.map((v) => v.name).join(', ')}) — likely a topic input parameter or a ` +
        `value set by another topic; verify the source provides it.`,
    );
  }
  // Honest limitation: connector/HTTP action input bindings aren't in the graph.
  if (graph.nodes.some((n) => n.kind === 'action' && (n.dependencyType === 'connector' || n.dependencyType === 'http'))) {
    notes.push('Action nodes may consume variables as inputs; those bindings are not captured by the parser and must be re-mapped when the tool is rebuilt.');
  }

  return { vars, stateIn, stateOut, unresolved, notes };
}
