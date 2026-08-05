/**
 * DEMO — a complete, realistic enterprise agent definition (name, description,
 * instructions, knowledge sources, topics) for an INTERNAL sales-enablement
 * agent an organization builds and publishes to its own sales reps — not a
 * customer-facing bot. Run through the REAL pipeline end to end:
 *   knowledge sources → classifyKnowledgeSource (real classifier)
 *   topics            → parseTopicGraph → planTopicsMigration → topicsEmit
 *
 * Run: cd server && npx tsx src/spikes/_demo_sales_copilot_full_agent.ts
 */
import { parseTopicGraph } from '../services/topicGraph.js';
import { planTopicsMigration } from '../services/topicsMigration.js';
import { buildConnectedAgentArtifact } from '../services/topicsEmit.js';
import { classifyKnowledgeSource } from '../services/knowledgeClassifier.js';
import type { AgentIR, TopicIR } from '../types.js';

// ── Agent identity (what the org actually configures) ────────────────────────

const NAME = 'Contoso Sales Copilot';
const DESCRIPTION =
  'Internal assistant for the Contoso sales organization — helps reps look up CRM data, ' +
  'request discount approvals, log call activity, and find approved competitive and pricing materials.';
const INSTRUCTIONS =
  "You are Contoso Sales Copilot, an internal tool for Contoso's sales representatives only — " +
  'never expose this agent to customers or prospects. Be direct and efficient; reps are busy. ' +
  'When answering product or competitive questions, only use the approved battlecards and pricing ' +
  'guide — never speculate on pricing or claims not found in those sources. Any discount above 15% ' +
  'requires manager approval — you may collect the details and submit the request, but you must ' +
  'never approve it yourself. Always confirm the account or opportunity name before writing anything ' +
  'to the CRM.';

// ── Knowledge sources (what the org attaches) — classified by the REAL rules ─

const KNOWLEDGE_SOURCES = [
  {
    name: 'Sales Battlecards.pdf',
    input: { kind: 'FileUpload', file: { name: 'Sales Battlecards.pdf', sizeBytes: 3_100_000 } },
  },
  {
    name: 'Pricing & Packaging Guide',
    input: {
      kind: 'SharePoint',
      references: ['https://contoso.sharepoint.com/sites/Sales/Shared Documents/Pricing and Packaging Guide.pdf'],
    },
  },
  {
    name: 'contoso.com/products (public site)',
    input: { kind: 'PublicWebsiteSource', references: ['https://www.contoso.com/products'] },
  },
];

console.log('================ KNOWLEDGE SOURCES (real classifier output) ================\n');
for (const ks of KNOWLEDGE_SOURCES) {
  const c = classifyKnowledgeSource(ks.input);
  console.log(`● ${ks.name}`);
  console.log(`    strategy      : ${c.strategy}`);
  console.log(`    geminiTarget  : ${c.geminiTarget}`);
  console.log(`    automatable   : ${c.automatable}`);
  console.log(`    notes         :`);
  for (const n of c.notes) console.log(`      - ${n}`);
  console.log('');
}

// ── Topics (source: what the org's makers built in Copilot Studio) ──────────

const YAML_GREETING = `
beginDialog:
  kind: OnConversationStart
  actions:
    - kind: SendActivity
      id: sa_greet
      activity: "Hi! I'm Contoso Sales Copilot — I can help with CRM lookups, discount approvals, and product/competitive info. What do you need?"
`;

const YAML_THANKS = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [thanks, thank you, appreciate it]
  actions:
    - kind: SendActivity
      id: sa1
      activity: "Anytime — good luck closing it!"
`;

const YAML_OPP_STAGE = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [check opportunity, what stage is this deal, opportunity status]
  actions:
    - kind: Question
      id: q_opp
      prompt: "Which opportunity — give me the name or ID?"
      property: Topic.OpportunityName
      entity: StringPrebuiltEntity
    - kind: InvokeConnectorAction
      id: act_query_opp
      connectionReference: shared_commondataserviceforapps.QueryOpportunity
    - kind: SendActivity
      id: sa_stage
      activity: "\\"{Topic.OpportunityName}\\" is currently at stage: {Topic.OpportunityStage}."
`;

const YAML_DISCOUNT = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [request a discount, need approval for a discount, discount approval]
  actions:
    - kind: Question
      id: q_amount
      prompt: "What's the deal amount?"
      property: Topic.DealAmount
      entity: NumberPrebuiltEntity
    - kind: Question
      id: q_discount
      prompt: "What discount percentage are you requesting?"
      property: Topic.DiscountPercent
      entity: NumberPrebuiltEntity
    - kind: ConditionGroup
      id: c_threshold
      conditions:
        - condition: "=Topic.DiscountPercent > 15"
          actions:
            - kind: InvokeConnectorAction
              id: act_notify_manager
              connectionReference: shared_teams.PostMessage
            - kind: SendActivity
              id: sa_sent
              activity: "That's above the 15% self-serve limit — I've sent it to your manager for approval."
      elseActions:
        - kind: SendActivity
          id: sa_ok
          activity: "That's within the 15% self-serve limit — you're clear to proceed, no approval needed."
`;

const YAML_LOG_ACTIVITY = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [log a call, log this activity, add a note to the account]
  actions:
    - kind: Question
      id: q_account
      prompt: "Which account is this for?"
      property: Topic.AccountName
      entity: StringPrebuiltEntity
    - kind: Question
      id: q_notes
      prompt: "What should I log — give me a quick summary?"
      property: Topic.CallNotes
      entity: StringPrebuiltEntity
    - kind: InvokeConnectorAction
      id: act_create_activity
      connectionReference: shared_commondataserviceforapps.CreateActivity
    - kind: SendActivity
      id: sa_logged
      activity: "Logged on {Topic.AccountName}: \\"{Topic.CallNotes}\\"."
`;

const YAML_COMPETITIVE = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [how do we compare to a competitor, competitive positioning, versus a rival product]
  actions:
    - kind: Question
      id: q_competitor
      prompt: "Which competitor are you up against?"
      property: Topic.CompetitorName
      entity: StringPrebuiltEntity
    - kind: SearchKnowledgeSources
      id: act_search_battlecard
    - kind: SendActivity
      id: sa_positioning
      activity: "Here's our positioning against {Topic.CompetitorName} from the approved battlecard."
`;

const YAML_HELP = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [help, what can you do, options]
  actions:
    - kind: SendActivity
      id: sa_intro
      activity: "I can check opportunity stage, submit discount approvals, log call activity, or pull competitive positioning."
    - kind: BeginDialog
      id: go_opp
      dialog: t_opp
    - kind: BeginDialog
      id: go_discount
      dialog: t_discount
`;

// ── Assemble an AgentIR (what the extractor produces) ────────────────────────

const t = (id: string, name: string, raw: string, isSystem = false): TopicIR => ({
  id, name, raw,
  graph: parseTopicGraph(raw),
  triggerPhrases: parseTopicGraph(raw).trigger.phrases,
  summary: '', messages: [], usesAiBuilder: false, usesAdaptiveCards: false, isSystem,
});

const ir: AgentIR = {
  sourceId: 'bot_sales_copilot',
  name: NAME,
  instructions: INSTRUCTIONS,
  description: DESCRIPTION,
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: ['Check an opportunity', 'Request a discount approval', 'Log a call'],
  knowledgeSources: [],
  unmapped: [],
  topics: [
    t('t_greeting', 'Greeting', YAML_GREETING, true),
    t('t_thanks', 'Thanks', YAML_THANKS),
    t('t_opp', 'Check Opportunity Stage', YAML_OPP_STAGE),
    t('t_discount', 'Request Discount Approval', YAML_DISCOUNT),
    t('t_log', 'Log Call Activity', YAML_LOG_ACTIVITY),
    t('t_competitive', 'Competitive Positioning', YAML_COMPETITIVE),
    t('t_help', 'Sales Help Menu', YAML_HELP),
  ],
};

// ── Run the topics pipeline ──────────────────────────────────────────────────

const plan = planTopicsMigration(ir, { granularity: 'monolithic' });
const allCaps = [...plan.systemCapabilities, ...plan.connectedAgents.flatMap((a) => a.capabilities)];

console.log('\n================ AGENT IDENTITY ================\n');
console.log(`name        : ${NAME}`);
console.log(`description : ${DESCRIPTION}`);
console.log(`instructions: ${INSTRUCTIONS}\n`);

console.log('================ PER-CAPABILITY (what the pipeline derived) ================\n');
for (const c of allCaps) {
  console.log(`● ${c.name}   [${c.classification} | fidelity=${c.fidelity} | determinism=${c.determinism}]`);
  console.log(`    triggers      : ${c.triggers.join(', ') || '(none)'}`);
  console.log(`    tools         : ${c.tools.map((x) => `${x.ref}${x.requiresWorkflow ? ' (→workflow)' : ''}`).join(', ') || '(none)'}`);
  console.log(`    needs review  : ${c.needsHumanReview}`);
  if (c.manualActions.length) console.log(`    manual actions: ${c.manualActions.join(' | ')}`);
  console.log(`    -- compiled procedure --`);
  console.log(c.procedure.split('\n').map((l) => '      ' + l).join('\n') || '      (none)');
  console.log('');
}

console.log('\n================ PLAN SUMMARY ================\n');
console.log(JSON.stringify(plan.summary, null, 2));

console.log('\n================ DESTINATION #2 — connected-agent artifact (preview) ================\n');
const art = buildConnectedAgentArtifact(plan);
console.log('rootInstruction:\n' + (art.rootInstruction || '(none)'));
console.log('\nsummary: ' + JSON.stringify(art.summary));
for (const ca of art.connectedAgents) {
  console.log(`\n▶ connected agent "${ca.displayName}" (id=${ca.id}, domain=${ca.domain})`);
  console.log(`   tools: ${ca.tools.map((x) => x.name).join(', ')}`);
  console.log(`   workflows required: ${ca.workflowsRequired.map((w) => `${w.ref} [${w.kind}] ←${w.capabilityId}`).join(' | ') || '(none)'}`);
}
