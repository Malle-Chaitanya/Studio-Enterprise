/**
 * Unit tests for Backend A (services/topicCompiler.ts). No DB, no I/O —
 * synthetic graphs only, so it runs anywhere:  npx tsx src/spikes/_test_topic_compiler.ts
 */
import { compileTopic, humanizeExpr } from '../services/topicCompiler.js';
import type { DialogNode, TopicGraph } from '../services/topicGraph.js';

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

// ── humanizeExpr ─────────────────────────────────────────────────────────────
console.log('\nhumanizeExpr:');
check('boolean equality', humanizeExpr('Topic.Confirm == true') === 'Confirm is true', humanizeExpr('Topic.Confirm == true'));
check('>= operator', humanizeExpr('=Topic.Age >= 18') === 'Age is at least 18', humanizeExpr('=Topic.Age >= 18'));
check('IsBlank', humanizeExpr('IsBlank(Topic.Email)') === 'Email is empty', humanizeExpr('IsBlank(Topic.Email)'));
check('not-equal', humanizeExpr('Topic.A <> "X"') === 'A is not "X"', humanizeExpr('Topic.A <> "X"'));
check('empty → default', humanizeExpr('') === 'the condition holds');

// ── echo ─────────────────────────────────────────────────────────────────────
console.log('\necho (message only):');
{
  const c = compileTopic(g('m', [N({ id: 'm', kind: 'message', text: "You're welcome." })]));
  check('renders Say', c.procedure.includes(`Say: "You're welcome."`), c.procedure);
  check('fidelity full', c.fidelity === 'full');
  check('determinism soft', c.determinism === 'soft');
}

// ── linear (question → message) ──────────────────────────────────────────────
console.log('\nlinear:');
{
  const c = compileTopic(g('q', [
    N({ id: 'q', kind: 'question', prompt: 'Your email?', storeIn: 'Email', entity: 'Email', next: 'm' }),
    N({ id: 'm', kind: 'message', text: 'Thanks.' }),
  ]));
  check('asks + saves', c.procedure.includes('Ask the user: "Your email?"') && c.procedure.includes('`Email`'), c.procedure);
  check('then says', c.procedure.includes('Say: "Thanks."'));
}

// ── branching with join (no duplicate tail) ──────────────────────────────────
console.log('\nbranching + join:');
{
  const c = compileTopic(g('q', [
    N({ id: 'q', kind: 'question', prompt: 'Sure?', storeIn: 'Confirm', next: 'c' }),
    N({ id: 'c', kind: 'condition', branches: [{ expr: 'Topic.Confirm == true', then: 'a' }], else: 'b' }),
    N({ id: 'a', kind: 'message', text: 'Reset done.', next: 'j' }),
    N({ id: 'b', kind: 'message', text: 'Carry on.', next: 'j' }),
    N({ id: 'j', kind: 'message', text: 'Anything else?' }),
  ]));
  check('emits If', c.procedure.includes('If Confirm is true:'), c.procedure);
  check('emits Otherwise', c.procedure.includes('Otherwise:'));
  const joinCount = (c.procedure.match(/Anything else\?/g) ?? []).length;
  check('join emitted exactly once', joinCount === 1, `count=${joinCount}\n${c.procedure}`);
}

// ── loop ─────────────────────────────────────────────────────────────────────
console.log('\nloop:');
{
  const c = compileTopic(g('s', [
    N({ id: 's', kind: 'setVar', target: 'i', expr: '=0', next: 'lp' }),
    N({ id: 'lp', kind: 'loop', itemVar: 'x', overVar: 'items', body: 'act', next: 'done' }),
    N({ id: 'act', kind: 'action', dependencyType: 'knowledge', ref: 'SearchKnowledge', next: 'lp' }),
    N({ id: 'done', kind: 'message', text: 'Done.' }),
  ]));
  check('sets var', c.procedure.includes('Set `i` to 0.'), c.procedure);
  check('renders loop', c.procedure.includes('Repeat for each `x` in `items`:'));
  check('reaches continuation', c.procedure.includes('Say: "Done."'));
}

// ── nested cross-topic call ──────────────────────────────────────────────────
console.log('\nnested (child-agent goto):');
{
  const c = compileTopic(
    g('m', [
      N({ id: 'm', kind: 'message', text: 'Restarting.', next: 'gt' }),
      N({ id: 'gt', kind: 'goto', dependencyType: 'child-agent', ref: 'topic-123' }),
    ]),
    { resolveTopicName: (r) => (r === 'topic-123' ? 'Reset Conversation' : undefined) },
  );
  check('resolves topic name', c.procedure.includes('Follow the "Reset Conversation" procedure'), c.procedure);
}

// ── side-effecting action → deterministic ────────────────────────────────────
console.log('\nside-effecting:');
{
  const c = compileTopic(g('a', [N({ id: 'a', kind: 'action', dependencyType: 'connector', ref: 'Salesforce.CreateCase' })]));
  check('flags deterministic', c.determinism === 'requires-deterministic', c.determinism);
  check('fidelity downgraded', c.fidelity === 'partial');
  check('has warning note', c.notes.some((n) => /deterministic tool/.test(n)));
}

// ── unknown node ─────────────────────────────────────────────────────────────
console.log('\nunknown node:');
{
  const c = compileTopic(g('u', [N({ id: 'u', kind: 'unknown', rawKind: 'SomeFutureAction' })]));
  check('fidelity partial', c.fidelity === 'partial');
  check('preserved in text', c.procedure.includes('SomeFutureAction'), c.procedure);
  check('note recorded', c.notes.some((n) => /manual review/.test(n)));
}

// ── AI Builder folding ───────────────────────────────────────────────────────
console.log('\nai-builder folding:');
{
  const c = compileTopic(
    g('a', [N({ id: 'a', kind: 'action', dependencyType: 'ai-builder-model', ref: 'model-1' })]),
    { aiPromptFor: () => 'Summarize the company from its public filings.' },
  );
  check('folds prompt', c.procedure.includes('Summarize the company from its public filings.'), c.procedure);
  check('fidelity high', c.fidelity === 'high');
}

// ── implicit else (branch → join): no dangling "Otherwise", no de-indent ─────
console.log('\nimplicit else (branch → join):');
{
  const c = compileTopic(g('c', [
    N({ id: 'c', kind: 'condition', branches: [{ expr: 'Topic.X == true', then: 'a' }], else: 'j' }),
    N({ id: 'a', kind: 'message', text: 'Did A.', next: 'j' }),
    N({ id: 'j', kind: 'message', text: 'Continue.' }),
  ]));
  check('no dangling Otherwise', !c.procedure.includes('Otherwise:'), c.procedure);
  check('join at base indent', c.procedure.includes('\n- Say: "Continue."') || c.procedure.startsWith('- If'), c.procedure);
  const jc = (c.procedure.match(/Continue\./g) ?? []).length;
  check('continuation once', jc === 1, `count=${jc}`);
}

// ── loop var cleaning ────────────────────────────────────────────────────────
console.log('\nloop var cleaning:');
{
  const c = compileTopic(g('lp', [
    N({ id: 'lp', kind: 'loop', itemVar: 'init:Topic.eachItem', overVar: '=Global.myList', body: 'm', next: undefined }),
    N({ id: 'm', kind: 'message', text: 'x', next: 'lp' }),
  ]));
  check('cleans item/collection refs', c.procedure.includes('Repeat for each `eachItem` in `myList`:'), c.procedure);
}

// ── data-plumbing setVar summarized, not dumped ──────────────────────────────
console.log('\ndata-plumbing setVar:');
{
  const c = compileTopic(g('s', [
    N({ id: 's', kind: 'setVar', target: 'Topic.Payload', expr: '=Concatenate("{", JSON(Topic.a), "}")' }),
  ]));
  check('summarized, not raw', c.procedure.includes('Prepare `Payload`') && !c.procedure.includes('Concatenate'), c.procedure);
}

// ── AI prompt dedup within a topic ───────────────────────────────────────────
console.log('\nai prompt dedup:');
{
  const c = compileTopic(
    g('a1', [
      N({ id: 'a1', kind: 'action', dependencyType: 'ai-builder-model', ref: 'model-x', next: 'a2' }),
      N({ id: 'a2', kind: 'action', dependencyType: 'ai-builder-model', ref: 'model-x' }),
    ]),
    { aiPromptFor: () => 'Do the big reasoning task.' },
  );
  const full = (c.procedure.match(/Do the big reasoning task\./g) ?? []).length;
  check('prompt folded once', full === 1, `count=${full}\n${c.procedure}`);
  check('second references it', c.procedure.includes('same AI reasoning step'), c.procedure);
}

console.log(`\n${'─'.repeat(50)}\n ${pass} passed · ${fail} failed\n`);
process.exit(fail ? 1 : 0);
