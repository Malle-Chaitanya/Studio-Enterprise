/**
 * DEMO — a Sales agent's topics, source → destination, through the REAL
 * pipeline (parseTopicGraph → planTopicsMigration → state threading →
 * topicsEmit). Run: cd server && npx tsx src/spikes/_demo_sales_topics_e2e.ts
 *
 * Agent: "Contoso Sales Assistant". Topics span the same spectrum as the IT
 * service desk demo, in a sales domain:
 *   1. Thanks              — QA / echo                   (full)
 *   2. Product Pricing     — guided QA + branch           (soft)
 *   3. Check Order Status  — guided QA + branch           (soft)
 *   4. Create Lead         — transactional (connector) + a DEAD variable ref
 *   5. Schedule Demo       — transactional (connector)    (requires-deterministic)
 *   6. Sales Help Menu     — orchestration (calls topics)
 */
import { parseTopicGraph } from '../services/topicGraph.js';
import { planTopicsMigration } from '../services/topicsMigration.js';
import { buildProceduresInstruction, buildConnectedAgentArtifact } from '../services/topicsEmit.js';
import type { AgentIR, TopicIR } from '../types.js';

// ── Source: real-shaped AdaptiveDialog YAML per topic ────────────────────────

const YAML_THANKS = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [thanks, thank you, appreciate it, cool thanks]
  actions:
    - kind: SendActivity
      id: sa1
      activity: "You're welcome! Anything else I can help with on our products?"
`;

const YAML_PRICING = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [how much does it cost, pricing, what's the price, plans and pricing]
  actions:
    - kind: Question
      id: q_plan
      prompt: "Which plan are you interested in — Standard or Enterprise?"
      property: Topic.PlanName
      entity: StringPrebuiltEntity
    - kind: ConditionGroup
      id: c_plan
      conditions:
        - condition: "=Topic.PlanName = \\"Enterprise\\""
          actions:
            - kind: SendActivity
              id: sa_ent
              activity: "Enterprise pricing is custom — I'll connect you with a rep for a quote."
      elseActions:
        - kind: SendActivity
          id: sa_std
          activity: "The Standard plan is $49/user/month, billed annually."
`;

const YAML_ORDER = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [check my order, order status, where is my order, track order]
  actions:
    - kind: Question
      id: q_order
      prompt: "What's your order number?"
      property: Topic.OrderId
      entity: StringPrebuiltEntity
    - kind: ConditionGroup
      id: c_order
      conditions:
        - condition: "=!IsBlank(Topic.OrderId)"
          actions:
            - kind: SendActivity
              id: sa_found
              activity: "Looking up order {Topic.OrderId} — I'll share its current status."
      elseActions:
        - kind: SendActivity
          id: sa_none
          activity: "I'll need an order number to look that up."
`;

const YAML_LEAD = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [i'm interested, contact sales, talk to sales, get a quote]
  actions:
    - kind: Question
      id: q_name
      prompt: "What's your name?"
      property: Topic.ContactName
      entity: StringPrebuiltEntity
    - kind: Question
      id: q_company
      prompt: "What company are you with?"
      property: Topic.Company
      entity: StringPrebuiltEntity
    - kind: Question
      id: q_email
      prompt: "What's the best email to reach you at?"
      property: Topic.Email
      entity: EmailPrebuiltEntity
    - kind: InvokeConnectorAction
      id: act_create_lead
      connectionReference: shared_salesforce.CreateLead
    - kind: SendActivity
      id: sa_done
      activity: "Thanks {Topic.ContactName}! Lead {Topic.LeadId} has been created — a rep from our team will reach out shortly."
`;

const YAML_DEMO = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [book a demo, schedule a demo, can i see a demo, set up a demo]
  actions:
    - kind: Question
      id: q_email_demo
      prompt: "What email should the invite go to?"
      property: Topic.Email
      entity: EmailPrebuiltEntity
    - kind: Question
      id: q_time
      prompt: "What day and time works best for you?"
      property: Topic.PreferredTime
      entity: StringPrebuiltEntity
    - kind: InvokeConnectorAction
      id: act_book_demo
      connectionReference: shared_office365.CreateEvent
    - kind: SendActivity
      id: sa_booked
      activity: "You're all set — a calendar invite for {Topic.PreferredTime} has been sent to {Topic.Email}."
`;

const YAML_HELP = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [help, what can you do, options, main menu]
  actions:
    - kind: SendActivity
      id: sa_intro
      activity: "I can help with pricing, order status, booking a demo, or connecting you with sales."
    - kind: BeginDialog
      id: go_order
      dialog: t_order
    - kind: BeginDialog
      id: go_lead
      dialog: t_lead
`;

// ── Assemble an AgentIR (what the extractor produces) ────────────────────────

const t = (id: string, name: string, raw: string, isSystem = false): TopicIR => ({
  id, name, raw,
  graph: parseTopicGraph(raw),
  triggerPhrases: parseTopicGraph(raw).trigger.phrases,
  summary: '', messages: [], usesAiBuilder: false, usesAdaptiveCards: false, isSystem,
});

const ir: AgentIR = {
  sourceId: 'bot_sales',
  name: 'Contoso Sales Assistant',
  instructions: 'You are the Contoso Sales Assistant. Be upbeat, concise, and always try to move the conversation toward a next step (demo, quote, or purchase).',
  description: 'Helps prospects with pricing, order status, demo booking, and lead capture.',
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: ['What are your prices?', 'Book a demo'],
  knowledgeSources: [],
  unmapped: [],
  topics: [
    t('t_thanks', 'Thanks', YAML_THANKS),
    t('t_pricing', 'Product Pricing', YAML_PRICING),
    t('t_order', 'Check Order Status', YAML_ORDER),
    t('t_lead', 'Create Lead', YAML_LEAD),
    t('t_demo', 'Schedule Demo', YAML_DEMO),
    t('t_help', 'Sales Help Menu', YAML_HELP),
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
