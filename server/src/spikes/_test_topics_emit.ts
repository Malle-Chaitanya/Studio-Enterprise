/**
 * Unit tests for topics EMIT (services/topicsEmit.ts). No DB, no I/O:
 *   npx tsx src/spikes/_test_topics_emit.ts
 */
import { planTopicsMigration } from '../services/topicsMigration.js';
import { buildProceduresInstruction, buildConnectedAgentArtifact, renderCapability } from '../services/topicsEmit.js';
import type { DialogNode, TopicGraph } from '../services/topicGraph.js';
import type { AgentIR, TopicIR } from '../types.js';

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, extra?: string): void {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `  — ${extra}` : ''}`); }
}
const N = (n: Partial<DialogNode> & { id: string; kind: DialogNode['kind'] }): DialogNode => ({ rawKind: n.kind, ...n });
const graph = (rootNodeId: string, nodes: DialogNode[]): TopicGraph => ({
  trigger: { kind: 'OnRecognizedIntent', type: 'intent', phrases: [] }, rootNodeId, nodes,
});
const topic = (t: Partial<TopicIR> & { id: string; name: string; graph: TopicGraph }): TopicIR => ({
  raw: '', triggerPhrases: [], summary: '', messages: [], usesAiBuilder: false, usesAdaptiveCards: false, isSystem: false, ...t,
});

const ir: AgentIR = {
  sourceId: 'bot1',
  name: 'Support Agent',
  instructions: 'You are a helpful support agent.',
  description: 'Handles support questions.',
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: [],
  knowledgeSources: [],
  unmapped: [],
  topics: [
    topic({
      id: 't_thanks', name: 'Thank you', triggerPhrases: ['thanks', 'thank you', 'ty'],
      graph: graph('m', [N({ id: 'm', kind: 'message', text: "You're welcome." })]),
    }),
    topic({
      id: 't_restart', name: 'Start Over', triggerPhrases: ['restart', 'start over'],
      graph: graph('q', [
        N({ id: 'q', kind: 'question', prompt: 'Are you sure?', storeIn: 'Topic.Confirm', next: 'c' }),
        N({ id: 'c', kind: 'condition', branches: [{ expr: '=Topic.Confirm = true', then: 'm' }], else: 'm2' }),
        N({ id: 'm', kind: 'message', text: 'Restarting.' }),
        N({ id: 'm2', kind: 'message', text: "Ok. Let's carry on." }),
      ]),
    }),
    topic({
      id: 't_case', name: 'Create Case', triggerPhrases: ['open a ticket'],
      graph: graph('a', [
        N({ id: 'a', kind: 'action', dependencyType: 'connector', ref: 'Salesforce.CreateCase', next: 'm' }),
        N({ id: 'm', kind: 'message', text: 'Case created.' }),
      ]),
    }),
    topic({
      id: 't_fallback', name: 'Fallback', isSystem: true,
      graph: graph('m', [N({ id: 'm', kind: 'message', text: 'Sorry, I did not understand.' })]),
    }),
  ],
};

const plan = planTopicsMigration(ir);

// ── plan sanity ──────────────────────────────────────────────────────────────
console.log('\nplan:');
check('4 capabilities', plan.summary.capabilities === 4, String(plan.summary.capabilities));
check('1 system capability', plan.systemCapabilities.length === 1);
check('Create Case is transactional', plan.connectedAgents.flatMap((a) => a.capabilities).some((c) => c.name === 'Create Case' && c.classification === 'transactional'));
check('1 deterministic tool', plan.summary.deterministicTools === 1, String(plan.summary.deterministicTools));

// ── procedures instruction (deployable-now path) ──────────────────────────────
console.log('\nbuildProceduresInstruction:');
const proc = buildProceduresInstruction(plan);
check('has procedures header', /## Conversation procedures/.test(proc));
check('carries trigger phrasing', /When the user says things like/.test(proc));
check('renders the thank-you reply', /You're welcome\./.test(proc));
check('renders the restart branch', /If Confirm is true/.test(proc), proc.slice(0, 400));
check('flags deterministic action', /deterministic tool\/workflow/.test(proc));
check('fallback → guidance not a procedure', /Conversation guidance/.test(proc));

// ── connected-agent artifact (dry-run preview) ────────────────────────────────
console.log('\nbuildConnectedAgentArtifact:');
const art = buildConnectedAgentArtifact(plan);
check('produces connected agents', art.connectedAgents.length >= 1, String(art.connectedAgents.length));
check('summary counts a workflow requirement', art.summary.workflowsRequired === 1, String(art.summary.workflowsRequired));
check('each agent has a stable id', art.connectedAgents.every((a) => /^ca_/.test(a.id)));
check('each agent has googleSearch', art.connectedAgents.every((a) => a.tools.some((t) => t.name === 'googleSearch')));

// ── renderCapability directly ─────────────────────────────────────────────────
console.log('\nrenderCapability:');
const restart = plan.connectedAgents.flatMap((a) => a.capabilities).find((c) => c.name === 'Start Over')!;
const rc = renderCapability(restart);
check('render includes name header', /### Start Over/.test(rc));
check('render includes steps', /Ask the user:/.test(rc), rc.slice(0, 300));

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
