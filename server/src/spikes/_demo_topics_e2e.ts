/**
 * DEMO — 5 production-shaped topics, source → destination, through the REAL
 * pipeline (parseTopicGraph → planTopicsMigration → state threading →
 * topicsEmit). Run: cd server && npx tsx src/_demo_topics_e2e.ts
 *
 * Agent: "Contoso IT Service Desk". Topics span the whole spectrum:
 *   1. Thank you        — QA / echo                (full)
 *   2. Check Ticket      — guided QA + state         (soft)
 *   3. Reset Password    — transactional (connector) (requires-deterministic)
 *   4. Create Incident   — transactional + a DEAD variable ref (unresolved)
 *   5. Help Menu         — orchestration (calls topics)
 */
import { parseTopicGraph } from './services/topicGraph.js';
import { planTopicsMigration } from './services/topicsMigration.js';
import { buildProceduresInstruction, buildConnectedAgentArtifact } from './services/topicsEmit.js';
import type { AgentIR, TopicIR } from './types.js';

// ── Source: real-shaped AdaptiveDialog YAML per topic ────────────────────────

const YAML_THANKS = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [thanks, thank you, thanks so much, ty]
  actions:
    - kind: SendActivity
      id: sa1
      activity: "You're welcome! Is there anything else I can help with?"
`;

const YAML_TICKET = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [check my ticket, ticket status, where is my ticket]
  actions:
    - kind: Question
      id: q1
      prompt: "What's your ticket number?"
      property: Topic.TicketId
      entity: StringPrebuiltEntity
    - kind: ConditionGroup
      id: c1
      conditions:
        - condition: "=!IsBlank(Topic.TicketId)"
          actions:
            - kind: SendActivity
              id: sa_found
              activity: "Looking up ticket {Topic.TicketId} — I'll share its current status."
      elseActions:
        - kind: SendActivity
          id: sa_none
          activity: "No ticket number provided, so I can't look it up."
`;

const YAML_RESET = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [reset my password, forgot password, password reset]
  actions:
    - kind: Question
      id: q_email
      prompt: "What's your work email?"
      property: Topic.Email
      entity: EmailPrebuiltEntity
    - kind: InvokeConnectorAction
      id: act_reset
      connectionReference: shared_azuread.ResetPassword
    - kind: SendActivity
      id: sa_done
      activity: "A password reset link has been sent to {Topic.Email}."
`;

const YAML_INCIDENT = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [open an incident, create a ticket, report an issue]
  actions:
    - kind: Question
      id: q_desc
      prompt: "Please describe the issue."
      property: Topic.Description
      entity: StringPrebuiltEntity
    - kind: SetVariable
      id: set_pri
      variable: Topic.Priority
      value: "=If(Topic.Urgent, \\"High\\", \\"Normal\\")"
    - kind: InvokeConnectorAction
      id: act_create
      connectionReference: shared_servicenow.CreateIncident
    - kind: SendActivity
      id: sa_num
      activity: "Your incident {Topic.IncidentNumber} has been created with {Topic.Priority} priority."
`;

const YAML_MENU = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [help, what can you do, menu, main menu]
  actions:
    - kind: SendActivity
      id: sa_intro
      activity: "I can help you check tickets, reset your password, or open an incident."
    - kind: BeginDialog
      id: go_ticket
      dialog: t_ticket
    - kind: BeginDialog
      id: go_reset
      dialog: t_reset
`;

// ── Assemble an AgentIR (what the extractor produces) ────────────────────────

const t = (id: string, name: string, raw: string, isSystem = false): TopicIR => ({
  id, name, raw,
  graph: parseTopicGraph(raw),
  triggerPhrases: parseTopicGraph(raw).trigger.phrases,
  summary: '', messages: [], usesAiBuilder: false, usesAdaptiveCards: false, isSystem,
});

const ir: AgentIR = {
  sourceId: 'bot_itdesk',
  name: 'Contoso IT Service Desk',
  instructions: 'You are the Contoso IT Service Desk assistant. Be concise, professional, and helpful.',
  description: 'Helps employees with tickets, password resets, and incidents.',
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: ['Check my ticket', 'Reset my password'],
  knowledgeSources: [],
  unmapped: [],
  topics: [
    t('t_thanks', 'Thank you', YAML_THANKS),
    t('t_ticket', 'Check Ticket Status', YAML_TICKET),
    t('t_reset', 'Reset Password', YAML_RESET),
    t('t_incident', 'Create Incident', YAML_INCIDENT),
    t('t_menu', 'Help Menu', YAML_MENU),
  ],
};

// ── Run the pipeline ─────────────────────────────────────────────────────────

const plan = planTopicsMigration(ir, { granularity: 'monolithic' });
const allCaps = [...plan.systemCapabilities, ...plan.connectedAgents.flatMap((a) => a.capabilities)];

console.log('\n================ PER-CAPABILITY (what the pipeline derived) ================\n');
for (const c of allCaps) {
  console.log(`● ${c.name}   [${c.classification} | fidelity=${c.fidelity} | determinism=${c.determinism}]`);
  console.log(`    triggers      : ${c.triggers.join(', ') || '(none)'}`);
  console.log(`    nodes         : ${c.provenance.nodeCount}`);
  console.log(`    tools         : ${c.tools.map((x) => `${x.ref}${x.requiresWorkflow ? ' (→workflow)' : ''}`).join(', ') || '(none)'}`);
  console.log(`    state in/out  : [${c.stateIn.join(', ')}] / [${c.stateOut.join(', ')}]`);
  console.log(`    unresolved    : [${c.unresolvedState.join(', ')}]`);
  console.log(`    needs review  : ${c.needsHumanReview}`);
  if (c.manualActions.length) console.log(`    manual actions: ${c.manualActions.join(' | ')}`);
  console.log(`    -- compiled procedure --`);
  console.log(c.procedure.split('\n').map((l) => '      ' + l).join('\n') || '      (none)');
  console.log('');
}

console.log('\n================ PLAN SUMMARY ================\n');
console.log(JSON.stringify(plan.summary, null, 2));

console.log('\n================ DESTINATION #1 — single-agent instruction (deployable now) ================\n');
console.log('[base instruction]\n' + ir.instructions + '\n');
console.log(buildProceduresInstruction(plan));

console.log('\n================ DESTINATION #2 — connected-agent artifact (preview) ================\n');
const art = buildConnectedAgentArtifact(plan);
console.log('rootInstruction:\n' + (art.rootInstruction || '(none)'));
console.log('\nsummary: ' + JSON.stringify(art.summary));
for (const ca of art.connectedAgents) {
  console.log(`\n▶ connected agent "${ca.displayName}" (id=${ca.id}, domain=${ca.domain})`);
  console.log(`   tools: ${ca.tools.map((x) => x.name).join(', ')}`);
  console.log(`   workflows required: ${ca.workflowsRequired.map((w) => `${w.ref} [${w.kind}] ←${w.capabilityId}`).join(' | ') || '(none)'}`);
}
