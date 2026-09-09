/**
 * Pure, offline translation of one Copilot Studio Agent Flow (`FlowIR`) into a Google
 * Application Integration definition. Runs in Phase 1 (extract/map) — no network calls,
 * same status as `mapper.ts` itself. See `.claude/rules/architecture-boundaries.md`.
 *
 * GENERIC BY DESIGN: this walks whatever action graph a real flow actually has (via
 * `flowExpression.ts`'s real WDL expression parser and the action graph's own `runAfter`
 * dependency edges) rather than special-casing named flows or fixed action counts. What
 * makes this honest rather than a guess is the fallback: anything this translator cannot
 * confidently reproduce — an unrecognized WDL function, a connector operation with no known
 * REST binding, a loop construct — is SPLICED out of the task graph (its predecessors wired
 * directly to its successors) and reported as a `FidelityNote`, never silently dropped or
 * guessed at. A reference to a spliced action's output propagates the same loss forward
 * rather than silently resolving to an empty string.
 *
 * Ground-truth ADAPTED FROM `spikes/_diag_auto_migrate_flow.ts` (the proven, hand-verified
 * FieldMappingTask/CONCAT-chain shape and top-level integration shape) — this module
 * generalizes that one-flow prototype into something that works for any flow's graph.
 */
import type {
  FlowIR,
  FlowActionIR,
  FlowParameterIR,
  MappedFlowIntegration,
  FidelityNote,
} from '../types.js';
import { parseTemplate, unwrapAccessors, isCallTo, type FlowExpr } from './flowExpression.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';

// ---------------------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------------------

/** A valid Application Integration variable/parameter key: letters, digits, underscore,
 *  never starting with a digit. Falls back to `_` for a name that sanitizes to nothing. */
function sanitizeIdent(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, '').trim();
  if (!cleaned) return '_';
  return /^[0-9]/.test(cleaned) ? `_${cleaned}` : cleaned;
}

/**
 * The Application Integration parameter key for one trigger input — prefers the author's
 * human-meaningful `displayName` (e.g. "NewLimit") over the raw WDL key (e.g. "number"),
 * since that's what makes the eventual ADK tool's arguments legible to the model.
 *
 * EXPORTED and MUST be the one place this is computed: it is baked into the trigger's own
 * `inputVariables.names` below (what Application Integration will actually accept), and it
 * is also what every compiled task script reads via `event.getParameter(...)` for a trigger
 * input. orchestrator.ts's `flowToolSpecs` must send the deployed tool's arguments under
 * these EXACT SAME keys — confirmed live 2026-09-08: it independently computed `p.name` (the
 * raw WDL key, e.g. "number") instead of calling this function, so the deployed tool sent
 * "number" while the flow's own filter script read "NewLimit" — the real value never
 * reached the comparison, which silently defaulted to 0 and matched only the first row of
 * every risk rating's band, no matter what limit was actually requested. A second,
 * independently-written copy of "compute the param key" is exactly how that drifted apart;
 * this being the only place it's computed is the actual fix, not a patch on one call site.
 */
export function paramKeyFor(p: FlowParameterIR): string {
  const preferred = p.displayName?.trim();
  return sanitizeIdent(preferred && preferred.length ? preferred : p.name);
}

/** The Application Integration variable name holding one action's translated result. */
function outVarFor(actionId: string): string {
  return `${sanitizeIdent(actionId)}_Out`;
}

/**
 * The deterministic Application Integration resource name for a source flow — MUST be
 * used identically by both the pure translation (which bakes `${name}_API_1` into the
 * trigger id inside the definition) and the Phase 2 creation service (which creates the
 * resource under this exact name), or the execute call built from one won't match the
 * definition built from the other. Shared here rather than duplicated.
 */
/**
 * The Application Integration name for a migrated flow: the source flow's own name,
 * exactly (case preserved — real successful integrations this session, e.g.
 * "GetRateSheetBand_AutoGen_v4", confirm mixed case is accepted), sanitized only enough
 * to satisfy Google's resource-id character rules. No vendor/tool branding (this
 * resource lives in the CUSTOMER's own project) and no id suffix.
 *
 * TRADEOFF, accepted deliberately rather than hidden: two flows that share the exact
 * same name (in different agents, or different environments) would collide on this
 * same resource name. Not yet observed on any real flow; if it ever happens, the second
 * flow's create/version-upload will need a disambiguation strategy that does not exist
 * yet — flagged here rather than silently guessed at.
 */
export function integrationNameForFlow(flowName: string): string {
  const sanitized = flowName
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return sanitized || 'flow';
}

function dataTypeFor(p: FlowParameterIR): string {
  switch (p.dataType) {
    case 'string':
      return 'STRING_VALUE';
    // WDL's JSON Schema `type: "number"` covers both integers and decimals — Copilot's
    // "Number" field type does not distinguish them either, so DOUBLE_VALUE (never
    // truncates) is the safer generic default. INT_VALUE was used for one hand-built demo
    // where the field happened to be a whole-dollar amount; a general translator should not
    // assume that.
    case 'number':
      return 'DOUBLE_VALUE';
    case 'boolean':
      return 'BOOLEAN_VALUE';
    default:
      // array/object/unknown: no lossless scalar mapping — JSON-serialize and let the
      // caller/model deal with the string, flagged via a fidelity note by the caller.
      return 'STRING_VALUE';
  }
}

// ---------------------------------------------------------------------------------------
// Topological ordering (WDL `runAfter` -> a safe processing order)
// ---------------------------------------------------------------------------------------

function topoOrder(actions: FlowActionIR[]): FlowActionIR[] {
  const byId = new Map(actions.map((a) => [a.id, a]));
  const ordered: FlowActionIR[] = [];
  const done = new Set<string>();
  const visiting = new Set<string>();
  function visit(a: FlowActionIR) {
    if (done.has(a.id) || visiting.has(a.id)) return; // cycle guard — never hang on bad data
    visiting.add(a.id);
    for (const depId of Object.keys(a.runAfter)) {
      const dep = byId.get(depId);
      if (dep) visit(dep);
    }
    visiting.delete(a.id);
    done.add(a.id);
    ordered.push(a);
  }
  for (const a of actions) visit(a);
  return ordered;
}

// ---------------------------------------------------------------------------------------
// Known Microsoft Graph bindings for flow-embedded connector actions.
//
// Deliberately small and explicit rather than claiming full generic coverage: this
// project's own `connectors/operationBinding.ts` already documents that Microsoft-family
// connectors (Excel/OneDrive/Teams/SharePoint) expose a Power Platform ABSTRACTION with no
// derivable vendor path — genericity there would mean guessing, which the honesty rule
// forbids. Each entry here is a REAL, live-verified Graph binding; anything not listed
// surfaces as `needs-review`, not a silent guess.
// ---------------------------------------------------------------------------------------

interface GraphOpBinding {
  /** `excel-range` marks a response shaped like `{text: [[header...], [row...], ...]}` —
   *  row 0 is the header — for the Query/JS compiler to zip into named-column objects. */
  resultShape?: 'excel-range';
  build: (params: Record<string, string>) => { method: string; url: string };
}

const GRAPH_OP_BINDINGS: Record<string, GraphOpBinding> = {
  // "List rows present in a table" — real binding confirmed against this session's actual
  // GetRateSheetBand flow. Uses the table's own `/range` (not a raw worksheet usedRange, and
  // not the author's UI-selected worksheet name) so the call targets the exact Table object
  // Copilot bound, headers included — a real fidelity improvement over the ad hoc
  // usedRange-based demo this session built by hand earlier.
  'shared_excelonlinebusiness:GetItems': {
    resultShape: 'excel-range',
    build: (p) => ({
      method: 'GET',
      url:
        `https://graph.microsoft.com/v1.0/drives/${encodeURIComponent(p.drive ?? '')}` +
        `/items/${encodeURIComponent(p.file ?? '')}/workbook/tables('${encodeURIComponent(p.table ?? '')}')/range`,
    }),
  },
};

/** Connector operations CONFIRMED live this session to be impossible under this tool's
 *  app-only Graph auth model — never silently attempted, never silently substituted. */
const KNOWN_BLOCKED_OPERATIONS: Record<string, string> = {
  'shared_teams:PostMessageToConversation':
    'Microsoft Graph refuses application-only (client-credentials) callers posting a Teams ' +
    'chat or channel message under any permission grant — confirmed live: 401 "Message POST ' +
    'is allowed in application-only context only for import purposes," reproduced against an ' +
    'existing chat, a newly-created chat, and 5 real channels. Needs a registered Bot ' +
    'Framework app with an established conversation, or a delegated (real user sign-in) ' +
    "token — not achievable with this tool's current app-only auth model.",
  'shared_teams:PostMessageToSelf':
    'Same restriction as PostMessageToConversation — a note-to-self is still a chatMessage ' +
    'POST, which application-only Graph credentials cannot perform.',
  'shared_teams:CreateChat':
    'Creating the chat object works app-only (Chat.Create — confirmed live), but the created ' +
    'chat cannot receive a first message app-only (same chatMessage POST restriction), so a ' +
    'flow that creates-then-posts is still blocked at the posting step.',
};

// ---------------------------------------------------------------------------------------
// Translation state
// ---------------------------------------------------------------------------------------

interface TaskConfig {
  task: string;
  taskId: string;
  parameters: Record<string, unknown>;
  taskExecutionStrategy: string;
  displayName: string;
  externalTaskType: string;
  nextTasks?: { taskId: string; condition?: string }[];
}

interface State {
  triggerNames: Set<string>; // raw WDL trigger property names (e.g. "text", "text_1", "number")
  triggerParamKeyByRawName: Map<string, string>;
  outputVarOf: Map<string, string>; // actionId -> its Application Integration output var, LIVE actions only
  lostIds: Set<string>;
  taskIdOf: Map<string, string>; // actionId -> assigned Application Integration taskId, LIVE actions only
  /**
   * actionId -> the task OTHER actions' `nextTasks` edges should route into, when that
   * differs from `taskIdOf.get(actionId)`. Only set for an action whose translation needed
   * synthetic PRE-tasks ahead of its own task (see `formatDateTime(utcNow(), ...)` handling
   * in resolveTemplate/translateCompose) — `taskIdOf` still names the action's OWN task (the
   * one whose output var represents its result, and whose `nextTasks` the auto-wiring loop
   * below points at real successors), while this names the chain's ENTRY point. Absent for
   * every ordinary action, where the two are the same task.
   */
  entryTaskIdOf: Map<string, string>;
  nextTaskId: number;
  taskConfigs: TaskConfig[];
  authConfigsNeeded: MappedFlowIntegration['authConfigsNeeded'];
  fidelityNotes: FidelityNote[];
}

function note(state: State, flowName: string, actionId: string, status: FidelityNote['status'], detail: string) {
  state.fidelityNotes.push({ component: `flow:${flowName}:${actionId}`, status, detail });
}

// ---------------------------------------------------------------------------------------
// Template resolution (Compose / Response bodies / connector parameters)
// ---------------------------------------------------------------------------------------

type Fragment = { literal: string } | { ref: string };

/**
 * `formatDateTime(utcNow(), "<.NET format>")` — confirmed live 2026-09-08 as the reason a
 * real customer flow (GenerateAmendmentDocument's date-stamp) failed to translate: an
 * extremely common Power Automate pattern (any document/report that stamps "today"), not a
 * one-off. utcNow() has no meaningful value at MIGRATION time — it must be computed when the
 * flow actually RUNS — so this can't become a literal fragment the way a trigger input or a
 * prior action's output can; it needs a real task that runs `new Date()` at execution time.
 * JavaScriptTask is the exact mechanism this codebase already uses for logic the CONCAT-chain
 * fragment model can't express (see the Query/Filter compiler below) — same proven pattern,
 * applied here instead of guessing at an unverified Application Integration date-transform
 * function (which, if the guess were wrong, would translate SILENTLY WRONG rather than
 * honestly flag the gap — worse than not translating at all).
 *
 * Only literal .NET format tokens are supported (yyyy/yy/MM/M/dd/d/HH/H/hh/h/mm/m/ss/s/tt) —
 * the common set used for document date-stamping. UTC getters throughout, matching utcNow()'s
 * own semantics — using local-time getters here would silently produce a different date/time
 * than the source flow depending on the container's timezone, a subtle correctness bug worse
 * than an honest "not yet supported" for a format token this doesn't recognize.
 */
function dotNetDateFormatToJs(fmt: string): string {
  const escaped = JSON.stringify(fmt);
  return [
    `function pad(n, w) { n = String(n); while (n.length < w) n = "0" + n; return n; }`,
    `var d = new Date();`,
    `var h24 = d.getUTCHours(); var h12 = h24 % 12 || 12;`,
    `var map = {`,
    `  yyyy: String(d.getUTCFullYear()), yy: pad(d.getUTCFullYear() % 100, 2),`,
    `  MM: pad(d.getUTCMonth() + 1, 2), M: String(d.getUTCMonth() + 1),`,
    `  dd: pad(d.getUTCDate(), 2), d: String(d.getUTCDate()),`,
    `  HH: pad(h24, 2), H: String(h24), hh: pad(h12, 2), h: String(h12),`,
    `  mm: pad(d.getUTCMinutes(), 2), m: String(d.getUTCMinutes()),`,
    `  ss: pad(d.getUTCSeconds(), 2), s: String(d.getUTCSeconds()),`,
    `  tt: h24 < 12 ? "AM" : "PM"`,
    `};`,
    `var formatted = ${escaped}.replace(/yyyy|yy|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s|tt/g, function(tok) { return map[tok]; });`,
  ].join('\n');
}

function resolveTemplate(
  value: string,
  state: State,
  actionId: string,
): { fragments: Fragment[]; unresolved: string[]; preTasks: TaskConfig[] } {
  const parts = parseTemplate(value);
  const fragments: Fragment[] = [];
  const unresolved: string[] = [];
  const preTasks: TaskConfig[] = [];
  let dateTaskCount = 0;
  for (const part of parts) {
    if (part.kind === 'literal') {
      fragments.push({ literal: part.text });
      continue;
    }
    if (
      part.expr.kind === 'call' &&
      part.expr.name === 'formatDateTime' &&
      part.expr.args.length === 2 &&
      part.expr.args[0].kind === 'call' &&
      part.expr.args[0].name === 'utcNow' &&
      part.expr.args[0].args.length === 0 &&
      part.expr.args[1].kind === 'string'
    ) {
      const fmt = part.expr.args[1].value;
      const outVar = outVarFor(`${actionId}_dateFmt${dateTaskCount++}`);
      const taskId = String(state.nextTaskId++);
      const script = [
        dotNetDateFormatToJs(fmt),
        `function executeScript(event) {`,
        `  event.setParameter(${JSON.stringify(outVar)}, formatted);`,
        `}`,
      ].join('\n');
      preTasks.push({
        task: 'JavaScriptTask',
        taskId,
        parameters: { script: { key: 'script', value: { stringValue: script } } },
        taskExecutionStrategy: 'WHEN_ALL_SUCCEED',
        displayName: `Format current date (${fmt})`,
        externalTaskType: 'NORMAL_TASK',
      });
      fragments.push({ ref: `$${outVar}$` });
      continue;
    }
    const u = unwrapAccessors(part.expr);
    if (u && isCallTo(u.root, 'triggerBody', 'triggerOutputs') && u.keys.length === 1 && state.triggerNames.has(u.keys[0])) {
      fragments.push({ ref: `$${state.triggerParamKeyByRawName.get(u.keys[0])}$` });
      continue;
    }
    if (u && isCallTo(u.root, 'outputs', 'body') && u.root.args[0]?.kind === 'string') {
      const refActionId = u.root.args[0].value;
      if (state.lostIds.has(refActionId)) {
        unresolved.push(`references action "${refActionId}", which could not be translated`);
        continue;
      }
      const outVar = state.outputVarOf.get(refActionId);
      if (!outVar) {
        unresolved.push(`references action "${refActionId}" before it has produced an output (unexpected ordering)`);
        continue;
      }
      if (u.keys.length > 0) {
        // Application Integration variables are flat scalars — a nested-key accessor onto
        // another action's output (e.g. Postoteams' `?['body/messageLink']`) can't be
        // reproduced as a simple `$Var$` reference. Flagged rather than guessed.
        unresolved.push(`references action "${refActionId}" with a nested key ("${u.keys.join('/')}") that a flat variable reference cannot reproduce`);
        continue;
      }
      fragments.push({ ref: `$${outVar}$` });
      continue;
    }
    unresolved.push(`unrecognized expression: ${describeExpr(part.expr)}`);
  }
  return { fragments, unresolved, preTasks };
}

function describeExpr(e: FlowExpr): string {
  if (e.kind === 'call') return `${e.name}(${e.args.map(describeExpr).join(', ')})`;
  if (e.kind === 'accessor') return `${describeExpr(e.base)}${e.safe ? '?' : ''}[${JSON.stringify(e.key)}]`;
  if (e.kind === 'string') return JSON.stringify(e.value);
  if (e.kind === 'number') return String(e.value);
  return e.text;
}

/** The proven recursive CONCAT chain shape (see spikes/_diag_auto_migrate_flow.ts). */
function buildConcatChain(fragments: Fragment[], i: number): unknown {
  const f = fragments[i];
  const initialValue = 'literal' in f ? { literalValue: { stringValue: f.literal } } : { referenceValue: f.ref };
  const node: Record<string, unknown> = { initialValue };
  if (i < fragments.length - 1) {
    node.transformationFunctions = [
      { functionType: { stringFunction: { functionName: 'CONCAT' } }, parameters: [buildConcatChain(fragments, i + 1)] },
    ];
  }
  return node;
}

function fieldMappingTask(taskId: string, displayName: string, mappedFields: unknown[]): TaskConfig {
  const fieldMappingConfig = {
    '@type': 'type.googleapis.com/enterprise.crm.eventbus.proto.FieldMappingConfig',
    mappedFields,
  };
  return {
    task: 'FieldMappingTask',
    taskId,
    parameters: {
      FieldMappingConfigTaskParameterKey: { key: 'FieldMappingConfigTaskParameterKey', value: { jsonValue: JSON.stringify(fieldMappingConfig) } },
    },
    taskExecutionStrategy: 'WHEN_ALL_SUCCEED',
    displayName,
    externalTaskType: 'NORMAL_TASK',
  };
}

// ---------------------------------------------------------------------------------------
// Query ("Filter array") -> JavaScriptTask, compiling the real WDL boolean-expression
// grammar into real JS rather than reproducing one hand-built filter script.
// ---------------------------------------------------------------------------------------

const NUMERIC_CAST_HELPER = `function __num(v) { return Number(String(v).replace(/[,$\\s]/g, "")); }`;

/** Compiles one WDL expression, used inside a Query `where` clause, into a JS source
 *  fragment. `row` is the loop variable name bound to the current zipped-row object.
 *  Returns undefined (rather than guessing) for anything this grammar subset doesn't cover. */
function compileWhereExpr(e: FlowExpr, row: string, state: State, opts: { triggerAccess: (rawKey: string) => string | undefined }): string | undefined {
  if (e.kind === 'string') return JSON.stringify(e.value);
  if (e.kind === 'number') return String(e.value);
  if (e.kind === 'accessor') {
    const u = unwrapAccessors(e);
    if (!u) return undefined;
    if (isCallTo(u.root, 'item') && u.keys.length === 1) return `${row}[${JSON.stringify(u.keys[0])}]`;
    if (isCallTo(u.root, 'triggerBody', 'triggerOutputs') && u.keys.length === 1) return opts.triggerAccess(u.keys[0]);
    return undefined;
  }
  if (e.kind === 'call') {
    const args = e.args.map((a) => compileWhereExpr(a, row, state, opts));
    if (args.some((a) => a === undefined)) return undefined;
    switch (e.name) {
      case 'and':
        return `(${args.join(' && ')})`;
      case 'or':
        return `(${args.join(' || ')})`;
      case 'not':
        return `(!${args[0]})`;
      case 'equals':
        return `(${args[0]} === ${args[1]})`;
      case 'less':
        return `(${args[0]} < ${args[1]})`;
      case 'lessOrEquals':
        return `(${args[0]} <= ${args[1]})`;
      case 'greater':
        return `(${args[0]} > ${args[1]})`;
      case 'greaterOrEquals':
        return `(${args[0]} >= ${args[1]})`;
      case 'int':
      case 'float':
      case 'decimal':
        return `__num(${args[0]})`;
      case 'string':
        return `String(${args[0]})`;
      case 'bool':
        return `Boolean(${args[0]})`;
      default:
        return undefined; // unrecognized function — honest fallback, never guessed
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Per-action translation
// ---------------------------------------------------------------------------------------

/**
 * Wires zero or more synthetic PRE-tasks (today only `formatDateTime(utcNow(), ...)`'s
 * date-formatting JavaScriptTask — see resolveTemplate) so they run immediately before an
 * action's own task, without disturbing the auto-wiring loop in translateFlow that connects
 * REAL actions to their REAL successors. Chains them start-to-finish and records the chain's
 * entry point in `entryTaskIdOf`, so anything that would otherwise point straight at
 * `finalTaskId` (another action's predecessor lookup, or `startTaskIds`) routes into the
 * chain's front instead — see entryTaskIdOf's own doc comment on State for why a second map
 * is needed rather than overloading `taskIdOf`.
 */
function chainPreTasks(preTasks: TaskConfig[], finalTaskId: string, state: State, actionId: string) {
  if (!preTasks.length) return;
  for (let i = 0; i < preTasks.length; i++) {
    preTasks[i].nextTasks = [{ taskId: i < preTasks.length - 1 ? preTasks[i + 1].taskId : finalTaskId }];
    state.taskConfigs.push(preTasks[i]);
  }
  state.entryTaskIdOf.set(actionId, preTasks[0].taskId);
}

function translateCompose(a: FlowActionIR, flow: FlowIR, state: State) {
  const template = a.compose?.template;
  if (typeof template !== 'string') {
    state.lostIds.add(a.id);
    note(state, flow.name, a.id, 'needs-review', 'Compose action with a non-string template (not a plain text expression) — not yet supported.');
    return;
  }
  const { fragments, unresolved, preTasks } = resolveTemplate(template, state, a.id);
  if (unresolved.length) {
    state.lostIds.add(a.id);
    note(state, flow.name, a.id, 'needs-review', `Could not fully translate this step: ${unresolved.join('; ')}.`);
    return;
  }
  const outVar = outVarFor(a.id);
  const taskId = String(state.nextTaskId++);
  const mappedFields = [
    {
      inputField: { fieldType: 'STRING_VALUE', transformExpression: buildConcatChain(fragments.length ? fragments : [{ literal: '' }], 0) },
      outputField: { referenceKey: `$${outVar}$`, fieldType: 'STRING_VALUE', cardinality: 'OPTIONAL' },
    },
  ];
  state.taskConfigs.push(fieldMappingTask(taskId, a.id.replace(/_/g, ' '), mappedFields));
  chainPreTasks(preTasks, taskId, state, a.id);
  state.taskIdOf.set(a.id, taskId);
  state.outputVarOf.set(a.id, outVar);
}

function translateResponse(
  a: FlowActionIR,
  flow: FlowIR,
  state: State,
  outParams: FlowParameterIR[],
): void {
  const schema = (a.response?.schema as { properties?: Record<string, { title?: string; description?: string }> } | undefined)?.properties ?? {};
  const body = (a.response?.bodyTemplate as Record<string, unknown> | undefined) ?? {};
  const mappedFields: unknown[] = [];
  const allPreTasks: TaskConfig[] = [];
  for (const [key, rawValue] of Object.entries(body)) {
    const meta = schema[key];
    const displayName = sanitizeIdent((meta?.title ?? meta?.description ?? key).trim());
    if (typeof rawValue !== 'string') {
      note(state, flow.name, a.id, 'needs-review', `Output field "${displayName}" is not a plain text expression — not yet supported.`);
      continue;
    }
    const { fragments, unresolved, preTasks } = resolveTemplate(rawValue, state, `${a.id}_${key}`);
    outParams.push({ name: key, displayName, dataType: 'string', required: false });
    if (unresolved.length) {
      note(state, flow.name, a.id, 'needs-review', `Output field "${displayName}" could not be fully translated: ${unresolved.join('; ')}.`);
      // Emit an empty-string mapping rather than dropping the OUT parameter entirely — a
      // tool whose declared output silently vanishes is worse than one that returns "".
      mappedFields.push({
        inputField: { fieldType: 'STRING_VALUE', transformExpression: { initialValue: { literalValue: { stringValue: '' } } } },
        outputField: { referenceKey: `$${displayName}$`, fieldType: 'STRING_VALUE', cardinality: 'OPTIONAL' },
      });
      continue;
    }
    allPreTasks.push(...preTasks);
    mappedFields.push({
      inputField: { fieldType: 'STRING_VALUE', transformExpression: buildConcatChain(fragments.length ? fragments : [{ literal: '' }], 0) },
      outputField: { referenceKey: `$${displayName}$`, fieldType: 'STRING_VALUE', cardinality: 'OPTIONAL' },
    });
  }
  if (mappedFields.length) {
    const taskId = String(state.nextTaskId++);
    state.taskConfigs.push(fieldMappingTask(taskId, 'Respond to agent', mappedFields));
    // Every field's pre-tasks chain together, then into this shared task — Response has
    // exactly one real task for all its fields, so there is only ever one entry point to
    // record no matter how many fields needed a synthetic date-format step.
    chainPreTasks(allPreTasks, taskId, state, a.id);
    state.taskIdOf.set(a.id, taskId);
  }
}

function translateConnector(a: FlowActionIR, flow: FlowIR, state: State) {
  const conn = a.connector;
  const connRef = flow.connectionReferences.find((c) => c.name === conn?.connectionReferenceName);
  const connectorId = connRef?.connectorId ?? 'unknown';
  const operationId = conn?.operationId ?? 'unknown';
  const key = `${connectorId}:${operationId}`;

  const blockedReason = KNOWN_BLOCKED_OPERATIONS[key];
  if (blockedReason) {
    state.lostIds.add(a.id);
    note(state, flow.name, a.id, 'lost', blockedReason);
    return;
  }

  const binding = GRAPH_OP_BINDINGS[key];
  if (!binding) {
    state.lostIds.add(a.id);
    note(
      state,
      flow.name,
      a.id,
      'needs-review',
      `No known REST binding for connector "${connectorId}" operation "${operationId}" — this step was not translated. The raw connector call is preserved in the extracted IR for manual implementation.`,
    );
    return;
  }

  // Resolve each bound parameter's value (usually a literal the author pinned, but routed
  // through the same template resolver in case it references a trigger input instead).
  const resolvedParams: Record<string, string> = {};
  const paramNotes: string[] = [];
  for (const [k, v] of Object.entries(conn?.parameters ?? {})) {
    if (typeof v !== 'string') {
      resolvedParams[k] = String(v);
      continue;
    }
    // preTasks intentionally unused/discarded here: a formatDateTime(utcNow(), ...) inside a
    // connector call parameter would produce a {ref} fragment, which the very next check
    // below already rejects as "not a plain literal value" — connector URL parameters need a
    // concrete string, so there is nothing a synthetic date-format task could do for this
    // call site even if wired up.
    const { fragments, unresolved } = resolveTemplate(v, state, a.id);
    if (unresolved.length) {
      paramNotes.push(`parameter "${k}": ${unresolved.join('; ')}`);
      continue;
    }
    // Connector parameters need a concrete string (they build a URL), not a $Var$ token —
    // a reference here would need runtime substitution GenericRestV2Task doesn't do for the
    // URL itself, so a non-literal parameter is honestly unsupported rather than guessed.
    if (fragments.some((f) => 'ref' in f)) {
      paramNotes.push(`parameter "${k}" is not a plain literal value (references a trigger input or another step's output) — not yet supported for connector call parameters`);
      continue;
    }
    resolvedParams[k] = fragments.map((f) => ('literal' in f ? f.literal : '')).join('');
  }
  if (paramNotes.length) {
    state.lostIds.add(a.id);
    note(state, flow.name, a.id, 'needs-review', `Could not fully resolve this connector call's parameters: ${paramNotes.join('; ')}.`);
    return;
  }

  const { method, url } = binding.build(resolvedParams);
  const credentialGroup = REGISTRY_BY_ID.get(connectorId)?.credentialGroup ?? connectorId;
  const authConfigName = sanitizeIdent(credentialGroup).toLowerCase();
  if (!state.authConfigsNeeded.some((x) => x.authConfigName === authConfigName)) {
    state.authConfigsNeeded.push({ connectorId, connectionReferenceName: conn!.connectionReferenceName, authConfigName });
  }
  const outVar = outVarFor(a.id);
  const taskId = String(state.nextTaskId++);
  state.taskConfigs.push({
    task: 'GenericRestV2Task',
    taskId,
    parameters: {
      httpMethod: { key: 'httpMethod', value: { stringValue: method } },
      url: { key: 'url', value: { stringValue: url } },
      authConfigName: { key: 'authConfigName', value: { stringValue: authConfigName } },
      responseBody: { key: 'responseBody', value: { stringArray: { stringValues: [`$${outVar}$`] } } },
      throwError: { key: 'throwError', value: { booleanValue: false } },
    },
    taskExecutionStrategy: 'WHEN_ALL_SUCCEED',
    displayName: a.id.replace(/_/g, ' '),
    externalTaskType: 'NORMAL_TASK',
  });
  state.taskIdOf.set(a.id, taskId);
  state.outputVarOf.set(a.id, outVar);
  // Remember the result shape for the Query compiler, keyed by output var.
  if (binding.resultShape) resultShapeByOutVar.set(outVar, binding.resultShape);
}

// Small side-table (module-scoped per translateFlow call — reset at the top of translateFlow)
// rather than threading one more field through State for a single, rare need.
let resultShapeByOutVar = new Map<string, 'excel-range'>();

function translateQuery(a: FlowActionIR, flow: FlowIR, state: State) {
  const inputs = a.raw as { inputs?: { from?: string; where?: string } } | undefined;
  const fromStr = inputs?.inputs?.from;
  const whereStr = inputs?.inputs?.where;
  if (typeof fromStr !== 'string' || typeof whereStr !== 'string') {
    state.lostIds.add(a.id);
    note(state, flow.name, a.id, 'needs-review', 'Filter/Query action is missing a recognizable from/where clause — not translated.');
    return;
  }
  const fromParts = parseTemplate(fromStr);
  const fromExpr = fromParts.length === 1 && fromParts[0].kind === 'expr' ? fromParts[0].expr : undefined;
  const fromRef = fromExpr ? unwrapAccessors(fromExpr) : undefined;
  if (!fromRef || !isCallTo(fromRef.root, 'outputs', 'body') || fromRef.root.args[0]?.kind !== 'string') {
    state.lostIds.add(a.id);
    note(state, flow.name, a.id, 'needs-review', `Filter/Query "from" clause not recognized: ${fromStr}.`);
    return;
  }
  const sourceActionId = fromRef.root.args[0].value;
  if (state.lostIds.has(sourceActionId)) {
    state.lostIds.add(a.id);
    note(state, flow.name, a.id, 'lost', `Depends on "${sourceActionId}", which could not be translated.`);
    return;
  }
  const sourceOutVar = state.outputVarOf.get(sourceActionId);
  if (!sourceOutVar) {
    state.lostIds.add(a.id);
    note(state, flow.name, a.id, 'needs-review', `"from" references "${sourceActionId}" before it has produced an output.`);
    return;
  }
  const shape = resultShapeByOutVar.get(sourceOutVar);
  if (shape !== 'excel-range') {
    state.lostIds.add(a.id);
    note(state, flow.name, a.id, 'needs-review', `Filtering a result of unrecognized shape (source: "${sourceActionId}") — not yet supported.`);
    return;
  }
  // The source's own accessor path (`body/value`, from the ORIGINAL connector's response
  // envelope) does NOT apply here: GRAPH_OP_BINDINGS replaced that call with a different
  // real Graph endpoint whose response has its own, different shape (`excel-range` ==
  // `{text: [[header...], [row...], ...]}` with no `.body` wrapper at all). Navigating the
  // source's path against our own binding's response would be a genuine runtime bug, not a
  // faithful translation — so a resolved `resultShape` always overrides the source's own
  // accessor path rather than combining with it.

  const whereExpr = parseTemplate(whereStr);
  const whereRoot = whereExpr.length === 1 && whereExpr[0].kind === 'expr' ? whereExpr[0].expr : undefined;
  const triggerAccessJs = (rawKey: string): string | undefined => {
    if (!state.triggerNames.has(rawKey)) return undefined;
    return `event.getParameter(${JSON.stringify(state.triggerParamKeyByRawName.get(rawKey))})`;
  };
  const compiledWhere = whereRoot ? compileWhereExpr(whereRoot, 'row', state, { triggerAccess: triggerAccessJs }) : undefined;
  if (!compiledWhere) {
    state.lostIds.add(a.id);
    note(state, flow.name, a.id, 'needs-review', `Filter condition uses an expression this translator does not yet understand: ${whereStr.trim()}.`);
    return;
  }

  const outVar = outVarFor(a.id);
  const taskId = String(state.nextTaskId++);
  const script = [
    NUMERIC_CAST_HELPER,
    `function executeScript(event) {`,
    `  var raw = event.getParameter(${JSON.stringify(sourceOutVar)});`,
    `  var parsed = JSON.parse(raw);`,
    `  var grid = parsed.text || [];`,
    `  var headers = grid[0] || [];`,
    `  var matches = [];`,
    `  for (var i = 1; i < grid.length; i++) {`,
    `    var cells = grid[i];`,
    `    var row = {};`,
    `    for (var c = 0; c < headers.length; c++) row[headers[c]] = cells[c];`,
    `    if (${compiledWhere}) matches.push(row);`,
    `  }`,
    `  event.setParameter(${JSON.stringify(outVar)}, JSON.stringify(matches));`,
    `}`,
  ].join('\n');

  state.taskConfigs.push({
    task: 'JavaScriptTask',
    taskId,
    parameters: { script: { key: 'script', value: { stringValue: script } } },
    taskExecutionStrategy: 'WHEN_ALL_SUCCEED',
    displayName: a.id.replace(/_/g, ' '),
    externalTaskType: 'NORMAL_TASK',
  });
  state.taskIdOf.set(a.id, taskId);
  state.outputVarOf.set(a.id, outVar);
}

// ---------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------

export function translateFlow(flow: FlowIR, opts: { integrationName: string }): MappedFlowIntegration {
  resultShapeByOutVar = new Map();
  const state: State = {
    triggerNames: new Set((flow.trigger?.inputSchema ?? []).map((p) => p.name)),
    triggerParamKeyByRawName: new Map((flow.trigger?.inputSchema ?? []).map((p) => [p.name, paramKeyFor(p)])),
    outputVarOf: new Map(),
    lostIds: new Set(),
    taskIdOf: new Map(),
    entryTaskIdOf: new Map(),
    nextTaskId: 1,
    taskConfigs: [],
    authConfigsNeeded: [],
    fidelityNotes: [],
  };

  const inputParameters = flow.trigger?.inputSchema ?? [];
  const outParameters: FlowParameterIR[] = [];

  const ordered = topoOrder(flow.actions);
  for (const a of ordered) {
    switch (a.type) {
      case 'Compose':
        translateCompose(a, flow, state);
        break;
      case 'Response':
        translateResponse(a, flow, state, outParameters);
        break;
      case 'OpenApiConnection':
        translateConnector(a, flow, state);
        break;
      case 'Query':
        translateQuery(a, flow, state);
        break;
      case 'If':
      case 'Switch':
        // Branching is structurally attempted (see below) but the Application Integration
        // `nextTasks[].condition` expression SYNTAX was never proven live this session —
        // only that the literal string 'true' is rejected. Flagged needs-review rather than
        // silently trusted; verify against a real deploy before relying on this in production.
        state.lostIds.add(a.id);
        note(
          state,
          flow.name,
          a.id,
          'needs-review',
          `${a.type} branching is not yet translated — Application Integration's condition ` +
            `expression syntax for branch routing has not been verified live. The branches' ` +
            `real logic is preserved in the extracted IR for manual implementation.`,
        );
        break;
      default:
        state.lostIds.add(a.id);
        note(state, flow.name, a.id, a.type === 'unknown' ? 'needs-review' : 'lost', `No Application Integration equivalent for WDL action type "${a.type}" — not translated.`);
    }
  }

  // Wire nextTasks: for each LIVE action, connect to the nearest LIVE successor(s),
  // bridging over any spliced (lost) intermediate actions so the graph stays connected.
  const successorsOf = new Map<string, string[]>(); // actionId -> ids that runAfter it
  for (const a of flow.actions) {
    for (const depId of Object.keys(a.runAfter)) {
      successorsOf.set(depId, [...(successorsOf.get(depId) ?? []), a.id]);
    }
  }
  function nearestLiveSuccessors(id: string, seen = new Set<string>()): string[] {
    if (seen.has(id)) return [];
    seen.add(id);
    const direct = successorsOf.get(id) ?? [];
    const result: string[] = [];
    for (const s of direct) {
      if (state.lostIds.has(s)) result.push(...nearestLiveSuccessors(s, seen));
      else if (state.taskIdOf.has(s)) result.push(s);
    }
    return result;
  }
  for (const a of flow.actions) {
    if (state.lostIds.has(a.id) || !state.taskIdOf.has(a.id)) continue;
    const nexts = nearestLiveSuccessors(a.id);
    if (nexts.length) {
      // A successor with its own synthetic pre-task chain (entryTaskIdOf) must be entered at
      // the CHAIN'S START, not its main task — otherwise the pre-task (e.g. the date-format
      // JavaScriptTask) never runs and the main task reads an unset variable.
      state.taskConfigs.find((t) => t.taskId === state.taskIdOf.get(a.id))!.nextTasks =
        nexts.map((n) => ({ taskId: state.entryTaskIdOf.get(n) ?? state.taskIdOf.get(n)! }));
    }
  }
  // startTasks: live actions with no live predecessor (their own runAfter deps are all
  // either absent, or all spliced away) run first.
  function hasLivePredecessor(a: FlowActionIR): boolean {
    for (const depId of Object.keys(a.runAfter)) {
      if (state.taskIdOf.has(depId)) return true;
      const dep = flow.actions.find((x) => x.id === depId);
      if (dep && state.lostIds.has(depId) && hasLivePredecessor(dep)) return true;
    }
    return false;
  }
  // Same entryTaskIdOf redirect as the successor-wiring loop above — a start action with a
  // synthetic pre-task chain must literally START at the pre-task, or it never runs.
  const startTaskIds = flow.actions
    .filter((a) => state.taskIdOf.has(a.id) && !hasLivePredecessor(a))
    .map((a) => state.entryTaskIdOf.get(a.id) ?? state.taskIdOf.get(a.id)!);

  const integrationDefinition = {
    description: `Auto-migrated from Copilot Studio Agent Flow "${flow.name}".`,
    triggerConfigs: [
      {
        label: 'API Trigger',
        startTasks: startTaskIds.map((taskId) => ({ taskId })),
        properties: { 'Trigger name': `${opts.integrationName}_API_1` },
        triggerType: 'API',
        triggerNumber: '1',
        triggerId: `api_trigger/${opts.integrationName}_API_1`,
        inputVariables: { names: inputParameters.map(paramKeyFor) },
        outputVariables: {},
      },
    ],
    taskConfigs: state.taskConfigs,
    integrationParameters: [
      ...inputParameters.map((p) => ({
        key: paramKeyFor(p),
        dataType: dataTypeFor(p),
        defaultValue: dataTypeFor(p) === 'DOUBLE_VALUE' ? { doubleValue: 0 } : dataTypeFor(p) === 'BOOLEAN_VALUE' ? { booleanValue: false } : { stringValue: '' },
        displayName: paramKeyFor(p),
        inputOutputType: 'IN',
      })),
      ...outParameters.map((p) => ({
        key: sanitizeIdent(p.displayName ?? p.name),
        dataType: 'STRING_VALUE',
        defaultValue: { stringValue: '' },
        displayName: sanitizeIdent(p.displayName ?? p.name),
        inputOutputType: 'OUT',
      })),
    ],
  };

  // Anything with a WDL type but no facade the switch above recognized (e.g. an action
  // that has raw content but genuinely produced no note) — defensive, should not happen
  // given the exhaustive switch, but never silently succeed if it does.
  for (const a of flow.actions) {
    if (!state.taskIdOf.has(a.id) && !state.lostIds.has(a.id)) {
      note(state, flow.name, a.id, 'needs-review', 'This step was not processed by the translator (unexpected internal state) — treat as not migrated.');
    }
  }

  const translatedCount = state.taskIdOf.size;
  const lostCount = state.lostIds.size;
  if (lostCount === 0) {
    state.fidelityNotes.unshift({ component: `flow:${flow.name}`, status: 'mapped', detail: `All ${translatedCount} step(s) translated.` });
  } else {
    state.fidelityNotes.unshift({
      component: `flow:${flow.name}`,
      status: translatedCount > 0 ? 'partial' : 'lost',
      detail: `${translatedCount} of ${flow.actions.length} step(s) translated; ${lostCount} could not be (see details below).`,
    });
  }

  return {
    flowId: flow.id,
    flowName: flow.name,
    integrationDefinition,
    inputParameters,
    authConfigsNeeded: state.authConfigsNeeded,
    fidelityNotes: state.fidelityNotes,
  };
}
