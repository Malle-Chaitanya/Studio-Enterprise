import { parse as parseYaml } from 'yaml';

/**
 * AdaptiveDialog → TopicGraph parser (AgentIR v2, §4).
 *
 * Turns a Copilot Studio topic's raw AdaptiveDialog YAML into a flat node graph
 * with explicit edges — the difference between migrating behavior and summarizing
 * it. LOSSLESS: any node kind we don't specifically model is preserved as an
 * 'unknown' node carrying its original `rawKind`, never dropped.
 *
 * Node kinds normalized from the real taxonomy observed across the tenant
 * (SetVariable, ConditionGroup, SendActivity, BeginDialog, Question, Foreach,
 * Invoke*Action, Search*, End*, etc.).
 */

export type NodeKind =
  | 'message'
  | 'question'
  | 'condition'
  | 'loop'
  | 'setVar'
  | 'action'
  | 'goto'
  | 'end'
  | 'unknown';

export interface DialogNode {
  id: string;
  kind: NodeKind;
  rawKind: string; // original AdaptiveDialog kind — lossless
  label?: string;
  next?: string;
  // question
  prompt?: string;
  storeIn?: string;
  entity?: string;
  // condition
  branches?: { expr: string; then: string }[];
  else?: string;
  // loop
  overVar?: string;
  itemVar?: string;
  body?: string;
  // setVar
  target?: string;
  expr?: string;
  // message
  text?: string;
  // action / goto
  ref?: string; // dependency ref (flow id, connector, model id, dialog id, url)
  dependencyType?: 'power-automate-flow' | 'connector' | 'ai-builder-model' | 'child-agent' | 'http' | 'knowledge';
}

export interface TopicGraph {
  trigger: { kind: string; type: 'intent' | 'event' | 'activity' | 'system' | 'unknown'; phrases: string[] };
  rootNodeId?: string;
  nodes: DialogNode[];
  parseError?: string;
}

// Map an AdaptiveDialog action kind → normalized node kind.
const KIND_MAP: Record<string, NodeKind> = {
  SendActivity: 'message',
  MessageBack: 'message',
  Question: 'question',
  CSATQuestion: 'question',
  OAuthInput: 'question',
  ConditionGroup: 'condition',
  Foreach: 'loop',
  SetVariable: 'setVar',
  SetTextVariable: 'setVar',
  SetMultipleVariables: 'setVar',
  ClearAllVariables: 'setVar',
  ParseValue: 'setVar',
  EditTableV2: 'setVar', // table-variable mutation → treated as a variable update
  EditTable: 'setVar',
  BeginDialog: 'goto',
  ReplaceDialog: 'goto',
  GotoAction: 'goto',
  EndDialog: 'end',
  EndConversation: 'end',
  CancelAllDialogs: 'end',
  BreakLoop: 'end',
  InvokeAIBuilderModelAction: 'action',
  InvokeConnectorAction: 'action',
  InvokeConnectorTaskAction: 'action',
  InvokeAIPluginTaskAction: 'action',
  HttpRequestAction: 'action',
  SearchAndSummarizeContent: 'action',
  SearchKnowledgeSources: 'action',
  SearchAllKnowledgeSources: 'action',
  SearchSpecificKnowledgeSources: 'action',
  SearchAllFiles: 'action',
};

const TRIGGER_TYPE: Record<string, TopicGraph['trigger']['type']> = {
  OnRecognizedIntent: 'intent',
  OnSelectIntent: 'intent',
  RecognizeIntent: 'intent',
  OnEventActivity: 'event',
  EventActivity: 'event',
  OnActivity: 'activity',
  OnConversationStart: 'system',
  OnUnknownIntent: 'system',
  OnRedirect: 'system',
  OnSystemRedirect: 'system',
  OnError: 'system',
  OnEscalate: 'system',
  OnSignIn: 'system',
};

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    // Common shapes: { text: '...' } or { literal: '...' } or activity objects
    const o = v as Record<string, unknown>;
    if (typeof o.text === 'string') return o.text;
    if (typeof o.literal === 'string') return o.literal;
  }
  return undefined;
}

/** Extract a dependency ref + type from an action node, best-effort. */
function extractRef(kind: string, a: Record<string, unknown>): { ref?: string; type?: DialogNode['dependencyType'] } {
  if (kind === 'InvokeAIBuilderModelAction') return { ref: asString(a.aIModelId) ?? '(model)', type: 'ai-builder-model' };
  if (kind === 'HttpRequestAction') return { ref: asString(a.url) ?? '(http)', type: 'http' };
  if (kind.startsWith('Search')) return { ref: kind, type: 'knowledge' };
  if (kind === 'BeginDialog' || kind === 'ReplaceDialog') return { ref: asString(a.dialog) ?? asString(a.dialogId) ?? '(dialog)', type: 'child-agent' };
  if (kind.startsWith('InvokeConnector')) {
    const conn = a.connectionReference ?? a.connectionProperties ?? a.apiId;
    return { ref: asString(conn) ?? '(connector)', type: 'connector' };
  }
  return {};
}

export function parseTopicGraph(rawYaml: string | null): TopicGraph {
  const empty: TopicGraph = { trigger: { kind: '', type: 'unknown', phrases: [] }, nodes: [] };
  if (!rawYaml) return empty;

  let doc: Record<string, unknown>;
  try {
    const parsed = parseYaml(rawYaml);
    if (!parsed || typeof parsed !== 'object') return empty;
    doc = parsed as Record<string, unknown>;
  } catch (err) {
    return { ...empty, parseError: (err as Error).message };
  }

  const begin = (doc.beginDialog ?? {}) as Record<string, unknown>;
  const triggerKind = (begin.kind as string) ?? '';
  const phrases: string[] = [];
  const intent = begin.intent as Record<string, unknown> | undefined;
  const tq = intent?.triggerQueries ?? (begin as Record<string, unknown>).triggerQueries;
  if (Array.isArray(tq)) for (const q of tq) if (typeof q === 'string') phrases.push(q);

  const nodes: DialogNode[] = [];
  let counter = 0;
  const genId = () => `n${counter++}`;

  // Parse a sequence of actions, wiring each node's `next` to the following
  // sibling (or `contId` for the last). Returns the entry node id.
  function parseSequence(actions: unknown, contId: string | undefined): string | undefined {
    if (!Array.isArray(actions) || actions.length === 0) return contId;
    let successor = contId;
    // Build back-to-front so each node knows its successor.
    for (let i = actions.length - 1; i >= 0; i--) {
      const a = actions[i];
      if (!a || typeof a !== 'object') continue;
      successor = buildNode(a as Record<string, unknown>, successor);
    }
    return successor;
  }

  // Build one node (recursing into condition/loop bodies). Returns its id.
  function buildNode(a: Record<string, unknown>, contAfter: string | undefined): string {
    const rawKind = (a.kind as string) ?? 'Unknown';
    const kind = KIND_MAP[rawKind] ?? 'unknown';
    const id = (typeof a.id === 'string' && a.id) || genId();
    const node: DialogNode = { id, kind, rawKind };

    switch (kind) {
      case 'condition': {
        const conds = Array.isArray(a.conditions) ? a.conditions : [];
        node.branches = conds.map((c) => {
          const cc = (c ?? {}) as Record<string, unknown>;
          const then = parseSequence(cc.actions, contAfter) ?? contAfter ?? '';
          return { expr: asString(cc.condition) ?? '=<expr>', then };
        });
        node.else = parseSequence(a.elseActions, contAfter) ?? contAfter;
        break;
      }
      case 'loop': {
        node.overVar = asString(a.itemsProperty) ?? asString(a.items);
        node.itemVar = asString(a.value);
        node.body = parseSequence(a.actions, id); // body loops back to this node
        node.next = contAfter;
        break;
      }
      case 'question': {
        node.prompt = asString(a.prompt);
        node.storeIn = asString(a.property) ?? asString(a.variable);
        node.entity = asString(a.entity);
        node.next = contAfter;
        break;
      }
      case 'setVar': {
        node.target = asString(a.variable) ?? asString(a.property);
        node.expr = asString(a.value) ?? asString(a.text);
        node.next = contAfter;
        break;
      }
      case 'message': {
        node.text = asString(a.activity) ?? asString(a.text);
        node.next = contAfter;
        break;
      }
      case 'goto': {
        const r = extractRef(rawKind, a);
        node.ref = r.ref;
        node.dependencyType = r.type;
        node.target = r.ref;
        // BeginDialog returns to caller; keep contAfter as fallthrough.
        node.next = contAfter;
        break;
      }
      case 'action': {
        const r = extractRef(rawKind, a);
        node.ref = r.ref;
        node.dependencyType = r.type;
        node.next = contAfter;
        break;
      }
      case 'end':
        // terminal — no next
        break;
      default: {
        // unknown — preserve losslessly, pass through to next
        node.label = rawKind;
        node.next = contAfter;
      }
    }
    nodes.push(node);
    return id;
  }

  const root = parseSequence(begin.actions, undefined);

  return {
    trigger: { kind: triggerKind, type: TRIGGER_TYPE[triggerKind] ?? 'unknown', phrases },
    rootNodeId: root,
    nodes,
  };
}

/** Validate a parsed graph per AgentIR v2 §7. Returns a list of problems (empty = valid). */
export function validateGraph(graph: TopicGraph): string[] {
  const problems: string[] = [];
  if (graph.parseError) problems.push(`parse error: ${graph.parseError}`);
  const ids = new Set(graph.nodes.map((n) => n.id));

  const checkEdge = (from: string, target: string | undefined, label: string) => {
    if (target && !ids.has(target)) problems.push(`node ${from}: ${label} → missing node "${target}"`);
  };

  for (const n of graph.nodes) {
    checkEdge(n.id, n.next, 'next');
    checkEdge(n.id, n.else, 'else');
    checkEdge(n.id, n.body, 'body');
    if (n.branches) n.branches.forEach((b, i) => checkEdge(n.id, b.then, `branch[${i}]`));
  }
  if (graph.rootNodeId && !ids.has(graph.rootNodeId)) {
    problems.push(`rootNodeId "${graph.rootNodeId}" not in nodes`);
  }
  return problems;
}

/** Summary counts used by the assessment engine. */
export function graphStats(graph: TopicGraph): Record<NodeKind, number> {
  const stats = { message: 0, question: 0, condition: 0, loop: 0, setVar: 0, action: 0, goto: 0, end: 0, unknown: 0 };
  for (const n of graph.nodes) stats[n.kind]++;
  return stats;
}
