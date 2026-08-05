/**
 * DEMO — "Neutara HR Assistant", a complete enterprise HR operations agent
 * built from the org's real HR Policies content (see
 * _fixtures_neutara_hr_policies.md — reproduced verbatim from the source
 * Claude Skill this org already uses). Run through the REAL pipeline:
 *   knowledge sources → classifyKnowledgeSource (real classifier)
 *   topics            → parseTopicGraph → planTopicsMigration → topicsEmit
 *
 * Run: cd server && npx tsx src/spikes/_demo_neutara_hr_agent.ts
 */
import { parseTopicGraph } from '../services/topicGraph.js';
import { planTopicsMigration } from '../services/topicsMigration.js';
import { buildConnectedAgentArtifact } from '../services/topicsEmit.js';
import { classifyKnowledgeSource } from '../services/knowledgeClassifier.js';
import type { AgentIR, TopicIR } from '../types.js';

// ── Agent identity ────────────────────────────────────────────────────────────

const NAME = 'Neutara HR Assistant';
const DESCRIPTION =
  'An enterprise HR assistant that helps Neutara Technologies employees with company policies, ' +
  'leave management, payroll guidance, HR procedures, and HR support requests. Answers policy ' +
  'questions using official company documentation and performs HR operations through integrated ' +
  'HR systems where applicable.';
const INSTRUCTIONS =
  "You are Neutara Technologies' official HR Assistant. Answer employee HR questions using only " +
  'approved HR policies — always prefer the official HR documents over assumptions. Help employees ' +
  'understand leave policies, payroll, HR procedures, conduct rules, and company benefits, and guide ' +
  'them through HR processes. When an employee requests an HR operation (leave, referral, loan, a ' +
  'ticket), collect all required information before proceeding. Never expose confidential employee ' +
  'information. Escalate requests that require HR approval rather than deciding yourself. Be polite, ' +
  'concise, and professional.';

// ── Knowledge sources — classified by the REAL rules ─────────────────────────

const KNOWLEDGE_SOURCES = [
  {
    name: 'HR Policies.md',
    input: { kind: 'FileUpload', file: { name: 'HR Policies.md', sizeBytes: 42_000 } },
  },
  {
    name: 'Employee Handbook.pdf',
    input: { kind: 'FileUpload', file: { name: 'Employee Handbook.pdf', sizeBytes: 1_800_000 } },
  },
];

console.log('================ KNOWLEDGE SOURCES (real classifier output) ================\n');
for (const ks of KNOWLEDGE_SOURCES) {
  const c = classifyKnowledgeSource(ks.input);
  console.log(`● ${ks.name}`);
  console.log(`    strategy      : ${c.strategy}`);
  console.log(`    geminiTarget  : ${c.geminiTarget}`);
  console.log(`    automatable   : ${c.automatable}`);
  for (const n of c.notes) console.log(`    - ${n}`);
  console.log('');
}

// ── Topics (source: what Neutara's makers built in Copilot Studio) ──────────

const YAML_POLICY_LOOKUP = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [hr policies, hr policy, company policies, policy questions, leave policy, loan policy, exit policy, conduct policy, shift allowance, employee referral]
  actions:
    - kind: Question
      id: q_policy
      prompt: "Which policy would you like to know about — Shift Allowances, Employee Referral, Loan, Conduct, Leave, or Exit & FnF?"
      property: Topic.PolicyName
      entity: StringPrebuiltEntity
    - kind: SearchKnowledgeSources
      id: act_search_policy
    - kind: SendActivity
      id: sa_summary
      activity: "Here's a quick summary of the {Topic.PolicyName} policy. Want more detail on any point? Just ask!"
`;

const YAML_APPLY_LEAVE = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [apply leave, request leave, take leave, vacation request, annual leave]
  actions:
    - kind: Question
      id: q_leave_type
      prompt: "What type of leave — Casual (CL), Sick (SL), Maternity, Paternity, or Comp-Off?"
      property: Topic.LeaveType
      entity: StringPrebuiltEntity
    - kind: Question
      id: q_start_date
      prompt: "What's the start date?"
      property: Topic.StartDate
      entity: DatePrebuiltEntity
    - kind: Question
      id: q_end_date
      prompt: "What's the end date?"
      property: Topic.EndDate
      entity: DatePrebuiltEntity
    - kind: InvokeConnectorAction
      id: act_submit_leave
      connectionReference: shared_hrms.SubmitLeaveRequest
    - kind: SendActivity
      id: sa_submitted
      activity: "Your {Topic.LeaveType} request from {Topic.StartDate} to {Topic.EndDate} has been submitted — request ID {Topic.RequestId}. Your manager has been notified."
`;

const YAML_LEAVE_BALANCE = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [leave balance, remaining leaves, how many leaves, check my leaves]
  actions:
    - kind: InvokeConnectorAction
      id: act_get_balance
      connectionReference: shared_hrms.GetLeaveBalance
    - kind: SendActivity
      id: sa_balance
      activity: "You have {Topic.CLBalance} Casual Leave(s) and {Topic.SLBalance} Sick Leave(s) remaining this year."
`;

const YAML_PAYSLIP = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [salary slip, payslip, payroll, download my payslip]
  actions:
    - kind: InvokeConnectorAction
      id: act_get_payslip
      connectionReference: shared_payroll.GetLatestPayslip
    - kind: SendActivity
      id: sa_payslip
      activity: "Here's your latest payslip: {Topic.PayslipLink}"
`;

const YAML_REFERRAL = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [refer employee, employee referral, referral bonus, refer a candidate]
  actions:
    - kind: Question
      id: q_candidate_name
      prompt: "What's the candidate's name?"
      property: Topic.CandidateName
      entity: StringPrebuiltEntity
    - kind: Question
      id: q_candidate_email
      prompt: "What's the candidate's email?"
      property: Topic.CandidateEmail
      entity: EmailPrebuiltEntity
    - kind: InvokeConnectorAction
      id: act_submit_referral
      connectionReference: shared_hrms.SubmitReferral
    - kind: SendActivity
      id: sa_referral_done
      activity: "Thanks! {Topic.CandidateName} has been submitted as a referral — you'll be notified once they complete 3 months, per the referral bonus structure."
`;

const YAML_LOAN = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [employee loan, salary loan, loan request, need a loan]
  actions:
    - kind: Question
      id: q_loan_amount
      prompt: "How much would you like to request?"
      property: Topic.LoanAmount
      entity: NumberPrebuiltEntity
    - kind: Question
      id: q_loan_purpose
      prompt: "What's the purpose of the loan?"
      property: Topic.LoanPurpose
      entity: StringPrebuiltEntity
    - kind: InvokeConnectorAction
      id: act_submit_loan
      connectionReference: shared_hrms.SubmitLoanRequest
    - kind: SendActivity
      id: sa_loan_submitted
      activity: "Your loan request for {Topic.LoanAmount} has been submitted — request ID {Topic.LoanRequestId}. HR will verify eligibility and forward it to the CEO for approval."
`;

const YAML_HR_TICKET = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [hr issue, complaint, raise hr ticket, need hr support]
  actions:
    - kind: Question
      id: q_ticket_category
      prompt: "What category is this — Payroll, Conduct, Leave, or Other?"
      property: Topic.TicketCategory
      entity: StringPrebuiltEntity
    - kind: Question
      id: q_ticket_desc
      prompt: "Please describe the issue."
      property: Topic.TicketDescription
      entity: StringPrebuiltEntity
    - kind: InvokeConnectorAction
      id: act_create_ticket
      connectionReference: shared_servicenow.CreateTicket
    - kind: SendActivity
      id: sa_ticket_created
      activity: "Your ticket has been created — number {Topic.TicketNumber}. HR has been notified and will follow up."
`;

const YAML_EXIT_PROCESS = `
beginDialog:
  kind: OnRecognizedIntent
  intent:
    triggerQueries: [resignation, notice period, full and final, exit process, how do i resign]
  actions:
    - kind: SearchKnowledgeSources
      id: act_search_exit
    - kind: SendActivity
      id: sa_exit_info
      activity: "Here's what you need to know about resigning: the notice period, asset return, and the FnF timeline. Want to talk to HR directly about your specific situation?"
`;

// ── Assemble an AgentIR (what the extractor produces) ────────────────────────

const t = (id: string, name: string, raw: string): TopicIR => ({
  id, name, raw,
  graph: parseTopicGraph(raw),
  triggerPhrases: parseTopicGraph(raw).trigger.phrases,
  summary: '', messages: [], usesAiBuilder: false, usesAdaptiveCards: false, isSystem: false,
});

const ir: AgentIR = {
  sourceId: 'bot_neutara_hr',
  name: NAME,
  instructions: INSTRUCTIONS,
  description: DESCRIPTION,
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: ['What is the leave policy?', 'Apply for leave', 'Check my leave balance'],
  knowledgeSources: [],
  unmapped: [],
  topics: [
    t('t_policy_lookup', 'HR Policy Lookup', YAML_POLICY_LOOKUP),
    t('t_apply_leave', 'Apply Leave', YAML_APPLY_LEAVE),
    t('t_leave_balance', 'Check Leave Balance', YAML_LEAVE_BALANCE),
    t('t_payslip', 'Download Payslip', YAML_PAYSLIP),
    t('t_referral', 'Employee Referral', YAML_REFERRAL),
    t('t_loan', 'Loan Request', YAML_LOAN),
    t('t_ticket', 'Raise HR Ticket', YAML_HR_TICKET),
    t('t_exit', 'Exit Process', YAML_EXIT_PROCESS),
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
  console.log(`    state in/out  : [${c.stateIn.join(', ')}] / [${c.stateOut.join(', ')}]`);
  console.log(`    unresolved    : [${c.unresolvedState.join(', ')}]`);
  console.log(`    needs review  : ${c.needsHumanReview}`);
  if (c.manualActions.length) console.log(`    manual actions: ${c.manualActions.join(' | ')}`);
  console.log('');
}

console.log('\n================ PLAN SUMMARY ================\n');
console.log(JSON.stringify(plan.summary, null, 2));

console.log('\n================ DESTINATION — connected-agent artifact (preview) ================\n');
const art = buildConnectedAgentArtifact(plan);
console.log('summary: ' + JSON.stringify(art.summary));
for (const ca of art.connectedAgents) {
  console.log(`\n▶ connected agent "${ca.displayName}" (domain=${ca.domain})`);
  console.log(`   workflows required: ${ca.workflowsRequired.map((w) => `${w.ref} [${w.kind}] ←${w.capabilityId}`).join(' | ') || '(none)'}`);
}
