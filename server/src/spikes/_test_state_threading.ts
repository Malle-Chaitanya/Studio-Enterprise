/**
 * Unit tests for state threading (services/stateThreading.ts). No DB, no I/O —
 * synthetic graphs only:  npx tsx src/_test_state_threading.ts
 */
import { analyzeState } from './services/stateThreading.js';
import type { DialogNode, TopicGraph } from './services/topicGraph.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  — ${extra}` : ''}`); }
}
const g = (rootNodeId: string, nodes: DialogNode[]): TopicGraph => ({
  trigger: { kind: 'OnRecognizedIntent', type: 'intent', phrases: [] }, rootNodeId, nodes,
});
const N = (n: Partial<DialogNode> & { id: string; kind: DialogNode['kind'] }): DialogNode => ({ rawKind: n.kind, ...n });

// ── write-then-read = local (resolved) ───────────────────────────────────────
console.log('\nwrite-then-read (local):');
{
  // Question saves Confirm → Condition reads Confirm. This is the "Start Over" shape.
  const s = analyzeState(g('q', [
    N({ id: 'q', kind: 'question', prompt: 'Are you sure?', storeIn: 'Topic.Confirm', next: 'c' }),
    N({ id: 'c', kind: 'condition', branches: [{ expr: '=Topic.Confirm = true', then: 'm' }] }),
    N({ id: 'm', kind: 'message', text: 'Ok.' }),
  ]));
  const confirm = s.vars.find((v) => v.name === 'Confirm');
  check('Confirm classified local', confirm?.direction === 'local', JSON.stringify(confirm));
  check('Confirm resolved', confirm?.resolved === true);
  check('no unresolved', s.unresolved.length === 0, JSON.stringify(s.unresolved));
}

// ── read with no writer = unresolved (dead ref) ──────────────────────────────
console.log('\nread-with-no-writer (unresolved):');
{
  const s = analyzeState(g('c', [
    N({ id: 'c', kind: 'condition', branches: [{ expr: 'Topic.DealId <> Blank()', then: 'm' }] }),
    N({ id: 'm', kind: 'message', text: 'ok' }),
  ]));
  check('DealId is unresolved', s.unresolved.some((v) => v.name === 'DealId'), JSON.stringify(s.vars));
  check('unresolved is an input', s.stateIn.some((v) => v.name === 'DealId'));
  check('has a review note', s.notes.some((n) => /no writer/i.test(n)));
}

// ── Global read = resolved input ─────────────────────────────────────────────
console.log('\nglobal read (resolved input):');
{
  const s = analyzeState(g('m', [
    N({ id: 'm', kind: 'message', text: 'Hello {Global.UserName}!' }),
  ]));
  const u = s.vars.find((v) => v.name === 'UserName');
  check('UserName scope global', u?.scope === 'global', JSON.stringify(u));
  check('UserName resolved input', u?.direction === 'in' && u?.resolved === true);
  check('no unresolved for global', s.unresolved.length === 0);
}

// ── System read = resolved (runtime-provided) ────────────────────────────────
console.log('\nsystem read (resolved):');
{
  const s = analyzeState(g('m', [N({ id: 'm', kind: 'message', text: 'Hi {System.User.DisplayName}' })]));
  const u = s.vars.find((v) => v.name === 'User');
  check('System var resolved', u?.scope === 'system' && u?.resolved === true, JSON.stringify(u));
}

// ── write-only = output ──────────────────────────────────────────────────────
console.log('\nwrite-only (output):');
{
  const s = analyzeState(g('s', [N({ id: 's', kind: 'setVar', target: 'Topic.Result', expr: '="done"' })]));
  const r = s.vars.find((v) => v.name === 'Result');
  check('Result is out', r?.direction === 'out', JSON.stringify(r));
  check('Result in stateOut', s.stateOut.some((v) => v.name === 'Result'));
}

// ── action-input limitation is disclosed ─────────────────────────────────────
console.log('\naction-input disclosure:');
{
  const s = analyzeState(g('a', [N({ id: 'a', kind: 'action', dependencyType: 'connector', ref: 'Salesforce.CreateCase' })]));
  check('notes the action-input limitation', s.notes.some((n) => /Action nodes may consume variables/i.test(n)));
}

// ── empty graph is safe ──────────────────────────────────────────────────────
console.log('\nempty graph:');
{
  const s = analyzeState(undefined);
  check('empty → no vars, no throw', s.vars.length === 0 && s.unresolved.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
