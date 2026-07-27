/**
 * Backend A — Topic graph → conversation procedure compiler (AgentIR v2).
 *
 * Turns a parsed TopicGraph (services/topicGraph.ts) into a numbered, natural-
 * language *procedure* the Gemini LLM agent can follow — the step that stops the
 * mapper from discarding the graph and collapsing a topic to a one-line summary.
 *
 * Design (matches the corpus we measured — shallow graphs, expression-heavy):
 *   • Structured walk with join detection, so if/else branches converge cleanly
 *     instead of duplicating their shared tail.
 *   • Cycle-safe: every node is emitted once; back-edges become explicit
 *     "return to…" references, never infinite recursion.
 *   • Power Fx → natural language for setVar/condition expressions (the #1 lever:
 *     90 setVar + 40 condition nodes in the tenant).
 *   • Honest verdicts: a side-effecting action (connector/http) marks the topic
 *     `requires-deterministic` (Backend C) — never silently softened.
 *
 * PURE: no I/O, no framework. Fully unit-testable (see _test_topic_compiler.ts).
 */
import type { DialogNode, TopicGraph } from './topicGraph.js';

export type Fidelity = 'full' | 'high' | 'partial';
export type Determinism = 'soft' | 'requires-deterministic';

export interface CompiledTopic {
  procedure: string; // markdown nested-bullet steps
  fidelity: Fidelity;
  determinism: Determinism;
  notes: string[]; // compiler warnings (low-confidence expr, unknown node, back-edge…)
}

/** Optional enrichment the agent-level layer can supply. */
export interface CompileContext {
  /** Resolve a cross-topic call target (dialog id) → human topic name. */
  resolveTopicName?: (ref: string) => string | undefined;
  /** The real AI Builder prompt text for an ai-builder-model action node. */
  aiPromptFor?: (node: DialogNode) => string | undefined;
}

// ── Power Fx → natural language ──────────────────────────────────────────────

/**
 * Best-effort Power Fx expression humanizer. Covers the common comparison/
 * boolean/blank forms seen in Copilot topics. Returns the rendered string; the
 * caller checks `looksLowConfidence` to decide whether to warn.
 */
export function humanizeExpr(raw?: string): string {
  if (!raw || !raw.trim()) return 'the condition holds';
  let e = raw.trim().replace(/^=/, '').trim();

  // Strip scope prefixes: Topic.X / Global.X / System.X / Bot.X → X
  e = e.replace(/\b(?:Topic|Global|System|Bot|conversation)\.([A-Za-z0-9_]+)/g, '$1');

  // Blank / provided
  e = e.replace(/!\s*IsBlank\s*\(([^()]+)\)/gi, '$1 is provided');
  e = e.replace(/IsBlank\s*\(([^()]+)\)/gi, '$1 is empty');
  e = e.replace(/IsEmpty\s*\(([^()]+)\)/gi, '$1 is empty');

  // Logical functions And(a, b) / Or(a, b) / Not(x)
  e = e.replace(/\bNot\s*\(([^()]+)\)/gi, 'not ($1)');
  e = e.replace(/\bAnd\s*\(/gi, '(');
  e = e.replace(/\bOr\s*\(/gi, '(');

  // Operators (order matters: multi-char before single)
  e = e
    .replace(/\s*==\s*/g, ' equals ')
    .replace(/\s*<>\s*/g, ' is not ')
    .replace(/\s*!=\s*/g, ' is not ')
    .replace(/\s*>=\s*/g, ' is at least ')
    .replace(/\s*<=\s*/g, ' is at most ')
    .replace(/\s*&&\s*/g, ' and ')
    .replace(/\s*\|\|\s*/g, ' or ')
    .replace(/\s*>\s*/g, ' is greater than ')
    .replace(/\s*<\s*/g, ' is less than ')
    .replace(/\s*=\s*/g, ' equals ');

  // Boolean literals read naturally after "equals"
  e = e.replace(/\bequals\s+true\b/gi, 'is true').replace(/\bequals\s+false\b/gi, 'is false');

  return e.replace(/\s+/g, ' ').trim();
}

/** Heuristic: did humanizeExpr leave un-translated Power Fx (a function call)? */
function looksLowConfidence(rendered: string): boolean {
  return /[A-Za-z_]\w*\s*\(/.test(rendered); // leftover function-call syntax
}

/** Clean a variable reference: strip `=`, `init:`, and scope prefixes. */
export function cleanVarRef(raw?: string): string {
  if (!raw || !raw.trim()) return 'value';
  const e = raw
    .trim()
    .replace(/^=/, '')
    .replace(/^init:/i, '')
    .replace(/\b(?:Topic|Global|System|Bot)\.([A-Za-z0-9_]+)/g, '$1')
    .trim();
  return e || 'value';
}

/**
 * A "data-plumbing" expression: string/table/JSON manipulation that builds a
 * payload for a downstream step. These CANNOT run in a Gemini LLM agent, so we
 * summarize them (raw preserved in the IR) rather than dump Power Fx into the
 * instruction — verbatim formulas are noise that degrade LLM behavior.
 */
function isDataPlumbing(expr?: string): boolean {
  if (!expr) return false;
  return (
    /\b(Concatenate|Concat|JSON|Filter|AddColumns|DropColumns|ForAll|Table|Split|Substitute|Mid|Find|Coalesce|Text)\s*\(/i.test(expr) ||
    expr.replace(/\s+/g, ' ').trim().length > 160
  );
}

/** Strip `{Topic.X}` / `{Global.X}` bindings in message text down to `{X}`. */
function cleanText(raw?: string): string {
  if (!raw) return '';
  return raw.replace(/\{\s*(?:Topic|Global|System|Bot)\.([A-Za-z0-9_]+)\s*\}/g, '{$1}').trim();
}

// ── Graph helpers ────────────────────────────────────────────────────────────

type NodeMap = Map<string, DialogNode>;

const SUCCESSORS = (n: DialogNode): string[] => {
  const out: string[] = [];
  if (n.next) out.push(n.next);
  if (n.else) out.push(n.else);
  if (n.body) out.push(n.body);
  n.branches?.forEach((b) => b.then && out.push(b.then));
  return out;
};

/** BFS reachable-set (ids → distance) from a start node, cycle-safe. */
function reachable(start: string | undefined, nodes: NodeMap): Map<string, number> {
  const dist = new Map<string, number>();
  if (!start || !nodes.has(start)) return dist;
  const q: [string, number][] = [[start, 0]];
  dist.set(start, 0);
  while (q.length) {
    const [id, d] = q.shift()!;
    const node = nodes.get(id);
    if (!node) continue;
    for (const s of SUCCESSORS(node)) {
      if (!dist.has(s) && nodes.has(s)) {
        dist.set(s, d + 1);
        q.push([s, d + 1]);
      }
    }
  }
  return dist;
}

/** The nearest node all of a condition's branches converge to (the join), if any. */
function joinOf(cond: DialogNode, nodes: NodeMap): string | undefined {
  const entries = [...(cond.branches?.map((b) => b.then) ?? []), cond.else].filter(
    (x): x is string => Boolean(x) && nodes.has(x!),
  );
  if (entries.length < 2) return undefined; // nothing to converge
  const sets = entries.map((e) => reachable(e, nodes));
  const [first, ...rest] = sets;
  let best: { id: string; score: number } | undefined;
  for (const [id, d0] of first) {
    if (!rest.every((s) => s.has(id))) continue; // common to all branches
    const score = d0 + rest.reduce((sum, s) => sum + (s.get(id) ?? 0), 0);
    if (!best || score < best.score) best = { id, score };
  }
  return best?.id;
}

// ── The compiler ─────────────────────────────────────────────────────────────

interface Line {
  indent: number;
  text: string;
}

export function compileTopic(graph: TopicGraph, ctx: CompileContext = {}): CompiledTopic {
  const notes: string[] = [];
  let fidelity: Fidelity = 'full';
  let determinism: Determinism = 'soft';
  const bump = (f: Fidelity) => {
    // full → high → partial (only ever downgrades)
    const rank = { full: 0, high: 1, partial: 2 };
    if (rank[f] > rank[fidelity]) fidelity = f;
  };

  if (!graph || graph.parseError || !graph.nodes.length) {
    return {
      procedure: '',
      fidelity: 'partial',
      determinism: 'soft',
      notes: [graph?.parseError ? `parse error: ${graph.parseError}` : 'no graph to compile'],
    };
  }

  const nodes: NodeMap = new Map(graph.nodes.map((n) => [n.id, n]));
  const emitted = new Set<string>();
  const aiEmitted = new Set<string>(); // dedup identical AI-model prompts within a topic
  const lines: Line[] = [];

  /** Render a one-line label for a leaf node. Returns undefined for `end` (no line). */
  function leafLine(n: DialogNode): string | undefined {
    switch (n.kind) {
      case 'message': {
        const t = cleanText(n.text);
        return t ? `Say: "${t}"` : 'Send a message to the user.';
      }
      case 'question': {
        const p = cleanText(n.prompt) || 'Ask the user for the required information';
        const store = n.storeIn ? ` — save their answer as \`${n.storeIn}\`` : '';
        const type = n.entity ? ` (${n.entity})` : '';
        return `Ask the user: "${p}"${store}${type}.`;
      }
      case 'setVar': {
        const target = cleanVarRef(n.target);
        if (isDataPlumbing(n.expr)) {
          // Summarize — the raw Power Fx stays in the IR for audit; it can't run
          // in Gemini and would only pollute the instruction.
          notes.push(`setVar \`${target}\`: data-plumbing expression summarized (raw preserved in IR).`);
          return `Prepare \`${target}\` (data preparation for the next step).`;
        }
        const expr = humanizeExpr(n.expr);
        if (looksLowConfidence(expr)) notes.push(`setVar \`${target}\`: expression may need review — "${(n.expr ?? '').slice(0, 100)}"`);
        return `Set \`${target}\` to ${expr}.`;
      }
      case 'action': {
        if (n.dependencyType === 'knowledge') return 'Search the connected knowledge sources for relevant information.';
        if (n.dependencyType === 'ai-builder-model') {
          const prompt = ctx.aiPromptFor?.(n);
          bump('high');
          if (!prompt) return 'Use AI reasoning to produce the required result.';
          // Dedup on the prompt TEXT (not model ref): the IR currently captures
          // one prompt per topic, so identical text must never print twice.
          const flat = prompt.replace(/\s+/g, ' ').trim();
          if (aiEmitted.has(flat)) return 'Use the same AI reasoning step described above.';
          aiEmitted.add(flat);
          return `Use AI reasoning to do the following: ${flat}`;
        }
        if (n.dependencyType === 'connector' || n.dependencyType === 'http') {
          determinism = 'requires-deterministic';
          bump('partial');
          notes.push(`side-effecting action (\`${n.ref}\`) — must be a deterministic tool (Backend C), not an instruction.`);
          return `Call the external system \`${n.ref}\` (⚠ deterministic tool required).`;
        }
        return `Perform the action \`${n.ref ?? n.rawKind}\`.`;
      }
      case 'goto': {
        if (n.dependencyType === 'child-agent') {
          const name = (n.ref && ctx.resolveTopicName?.(n.ref)) || n.ref || 'another topic';
          return `Follow the "${name}" procedure, then continue.`;
        }
        return undefined; // plain GotoAction handled as an edge, no user-visible step
      }
      case 'unknown':
        bump('partial');
        notes.push(`unsupported step "${n.rawKind}" — preserved for manual review.`);
        return `(Unsupported step "${n.rawKind}" — needs manual review.)`;
      default:
        return undefined;
    }
  }

  /** Structured walk of a sequence starting at `startId`, stopping at `stop`. */
  function renderSeq(startId: string | undefined, indent: number, stop: Set<string>, depth: number): void {
    let cur = startId;
    let guard = 0;
    while (cur && nodes.has(cur) && !stop.has(cur) && guard++ < 500) {
      if (emitted.has(cur)) {
        const n = nodes.get(cur)!;
        lines.push({ indent, text: `↩ Continue from the "${n.label ?? n.kind}" step above.` });
        notes.push('graph re-converges/loops back — rendered as a reference to keep it acyclic.');
        return;
      }
      if (depth > 40) {
        notes.push('procedure nesting exceeded safe depth — remainder flagged for review.');
        return;
      }
      emitted.add(cur);
      const node = nodes.get(cur)!;

      if (node.kind === 'condition') {
        const join = joinOf(node, nodes);
        const branchStop = new Set(stop);
        if (join) branchStop.add(join);
        // A branch has a real body only if it leads somewhere OTHER than the
        // convergence point (else it's an implicit "continue", not an else-block).
        const hasBody = (t?: string) =>
          Boolean(t) && t !== join && !branchStop.has(t!) && nodes.has(t!) && !emitted.has(t!);
        const branches = node.branches ?? [];
        branches.forEach((b, i) => {
          const expr = humanizeExpr(b.expr);
          if (looksLowConfidence(expr)) notes.push(`condition may need review — "${(b.expr ?? '').slice(0, 100)}"`);
          const head = i === 0 ? `If ${expr}` : `Otherwise, if ${expr}`;
          if (hasBody(b.then)) {
            lines.push({ indent, text: `${head}:` });
            renderSeq(b.then, indent + 1, branchStop, depth + 1);
          } else {
            lines.push({ indent, text: `${head}: continue.` });
          }
        });
        if (hasBody(node.else)) {
          lines.push({ indent, text: 'Otherwise:' });
          renderSeq(node.else, indent + 1, branchStop, depth + 1);
        }
        cur = join; // continue the main flow at the convergence point
        continue;
      }

      if (node.kind === 'loop') {
        const item = cleanVarRef(node.itemVar) || 'each item';
        const over = cleanVarRef(node.overVar) || 'the collection';
        lines.push({ indent, text: `Repeat for each \`${item}\` in \`${over}\`:` });
        const loopStop = new Set(stop);
        loopStop.add(node.id);
        if (node.next) loopStop.add(node.next);
        renderSeq(node.body, indent + 1, loopStop, depth + 1);
        cur = node.next;
        continue;
      }

      const line = leafLine(node);
      if (line) lines.push({ indent, text: line });
      cur = node.kind === 'end' ? undefined : node.next;
    }
  }

  renderSeq(graph.rootNodeId, 0, new Set(), 0);

  const procedure = lines.map((l) => `${'  '.repeat(l.indent)}- ${l.text}`).join('\n');
  // Dedup notes (same warning can fire per-node).
  const uniqueNotes = [...new Set(notes)];
  return { procedure, fidelity, determinism, notes: uniqueNotes };
}
