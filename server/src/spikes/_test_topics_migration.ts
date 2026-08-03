/**
 * Unit tests for Backend B (services/topicsMigration.ts). No DB, no I/O —
 * synthetic AgentIR only:  npx tsx src/spikes/_test_topics_migration.ts
 */
import { planTopicsMigration } from '../services/topicsMigration.js';
import type { AgentIR, TopicIR } from '../types.js';
import type { DialogNode, TopicGraph } from '../services/topicGraph.js';

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
  raw: '', triggerPhrases: [], summary: '', messages: [],
  usesAiBuilder: false, usesAdaptiveCards: false, isSystem: false, ...t,
});
const agent = (name: string, topics: TopicIR[]): AgentIR => ({
  sourceId: 's', name, instructions: '', description: '',
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: [], topics, knowledgeSources: [], unmapped: [],
});

// ── classification ────────────────────────────────────────────────────────────
console.log('\nclassification:');
{
  const ir = agent('Helpdesk', [
    topic({ id: 't1', name: 'Fallback', isSystem: true, graph: graph('m', [N({ id: 'm', kind: 'message', text: 'Sorry.' })]) }),
    topic({ id: 't2', name: 'PTO Policy', graph: graph('m', [N({ id: 'm', kind: 'message', text: 'You get 20 days.' })]) }),
    topic({ id: 't3', name: 'Reset Password', graph: graph('a', [N({ id: 'a', kind: 'action', dependencyType: 'connector', ref: 'AD.ResetPwd' })]) }),
    topic({ id: 't4', name: 'Main Menu', graph: graph('c', [
      N({ id: 'c', kind: 'condition', branches: [{ expr: '=x', then: 'g1' }, { expr: '=y', then: 'g2' }] }),
      N({ id: 'g1', kind: 'goto', dependencyType: 'child-agent', ref: 't2' }),
      N({ id: 'g2', kind: 'goto', dependencyType: 'child-agent', ref: 't3' }),
    ]) }),
  ]);
  const plan = planTopicsMigration(ir);
  const cls = (id: string) =>
    [...plan.systemCapabilities, ...plan.connectedAgents.flatMap((a) => a.capabilities)].find((c) => c.id === id)?.classification;
  check('system topic → system', cls('t1') === 'system', cls('t1'));
  check('message-only → qa', cls('t2') === 'qa', cls('t2'));
  check('connector action → transactional', cls('t3') === 'transactional', cls('t3'));
  check('2 child gotos → orchestration', cls('t4') === 'orchestration', cls('t4'));
  check('system kept out of connected agents', plan.systemCapabilities.length === 1 && plan.systemCapabilities[0].id === 't1');
}

// ── domain grouping ─────────────────────────────────────────────────────────
console.log('\ndomain grouping:');
{
  const ir = agent('IT Bot', [
    topic({ id: 'p1', name: 'Reset Password', triggerPhrases: ['reset password'], graph: graph('a', [N({ id: 'a', kind: 'action', dependencyType: 'connector', ref: 'AD.Reset' })]) }),
    topic({ id: 'p2', name: 'Change Password', triggerPhrases: ['change password'], graph: graph('a', [N({ id: 'a', kind: 'action', dependencyType: 'connector', ref: 'AD.Change' })]) }),
    topic({ id: 'v1', name: 'VPN Access', triggerPhrases: ['vpn'], graph: graph('a', [N({ id: 'a', kind: 'action', dependencyType: 'http', ref: 'https://vpn/api' })]) }),
  ]);
  const plan = planTopicsMigration(ir, { granularity: 'domain-grouped' });
  const pwdAgent = plan.connectedAgents.find((a) => a.capabilities.some((c) => c.id === 'p1'));
  check('password caps share one connected agent', pwdAgent?.capabilities.length === 2, `caps=${pwdAgent?.capabilities.length}`);
  check('vpn is a separate connected agent', plan.connectedAgents.some((a) => a.capabilities.length === 1 && a.capabilities[0].id === 'v1'));
  check('domain named from shared token', pwdAgent?.domain === 'Password', pwdAgent?.domain);
  check('tools deduped/collected on the group', (pwdAgent?.tools.length ?? 0) === 2, `tools=${pwdAgent?.tools.length}`);
  check('starter prompts from triggers', (pwdAgent?.starterPrompts ?? []).includes('reset password'));
}

// ── granularity knob ─────────────────────────────────────────────────────────
console.log('\ngranularity knob:');
{
  const ir = agent('Sales', [
    topic({ id: 'a', name: 'Competitor Landscape', graph: graph('a', [N({ id: 'a', kind: 'action', dependencyType: 'connector', ref: 'CRM.Deal' })]) }),
    topic({ id: 'b', name: 'Pricing Quote', graph: graph('a', [N({ id: 'a', kind: 'action', dependencyType: 'connector', ref: 'CRM.Price' })]) }),
  ]);
  check('monolithic → 1 connected agent', planTopicsMigration(ir, { granularity: 'monolithic' }).connectedAgents.length === 1);
  check('per-capability → 2 connected agents', planTopicsMigration(ir, { granularity: 'per-capability' }).connectedAgents.length === 2);
}

// ── honesty: fidelity, manual actions, review ────────────────────────────────
console.log('\nhonesty / provenance:');
{
  const ir = agent('Ops', [
    topic({ id: 't', name: 'Create Ticket', triggerPhrases: ['open ticket'], graph: graph('a', [N({ id: 'a', kind: 'action', dependencyType: 'connector', ref: 'ServiceNow.Create' })]) }),
  ]);
  const plan = planTopicsMigration(ir);
  const cap = plan.connectedAgents[0].capabilities[0];
  check('transactional flagged deterministic', cap.determinism === 'requires-deterministic', cap.determinism);
  check('fidelity downgraded to partial', cap.fidelity === 'partial', cap.fidelity);
  check('manual action to rebuild+reauth tool', cap.manualActions.some((m) => /Rebuild .*reconnect its auth/.test(m)), cap.manualActions.join(' | '));
  check('needs human review', cap.needsHumanReview === true);
  check('provenance traces to topic + nodes', cap.provenance.topicId === 't' && cap.provenance.nodeCount === 1);
  check('summary counts deterministic tools', plan.summary.deterministicTools === 1 && plan.summary.needsReview === 1);
}

console.log(`\n${'─'.repeat(50)}\n ${pass} passed · ${fail} failed\n`);
process.exit(fail ? 1 : 0);
