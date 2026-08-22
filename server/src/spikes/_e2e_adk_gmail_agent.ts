/**
 * End-to-end proof: a DEPLOYED Gemini agent reads a real Gmail mailbox.
 *
 * This is deliverable 4 of the M365 -> Workspace equivalence plan — the migrated equivalent
 * of a Copilot agent whose Outlook connector answered questions about mail.
 *
 * Everything upstream is already proven separately, so a failure here localises cleanly:
 *   - DWD + gmail.readonly reaches the mailbox      (_diag_gmail_dwd_probe.ts, all PASS)
 *   - the gmail.py tools return real data           (_test_gmail_tools.ts, all PASS)
 *   - the ADK pin produces a queryable deployment   (_test_adk_pin_proof.ts, PASS)
 * What is unproven is only the last link: that the tools survive into the Reasoning Engine
 * pickle and the model actually calls them.
 *
 * A 200 is not proof and prose is not proof. The model can describe an inbox it never read.
 * The evidence is a `function_call` frame naming a gmail_* tool plus a non-error
 * `function_response` — read structurally, the same way verify.ts does it.
 *
 *   cd server && npx tsx src/spikes/_e2e_adk_gmail_agent.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import { scanToolEvidence } from '../services/adkAgentChat.js';
import type { AgentIR, GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};

const ir: AgentIR = {
  sourceId: 'gmail-equivalence-proof-2026-08-19',
  name: 'Outlook-to-Gmail-Proof',
  description:
    'Diagnostic — proves a migrated Outlook-style mail agent reads Gmail through the ' +
    'cross-vendor equivalence tools. Safe to delete.',
  instructions:
    'You are a mail assistant. Answer questions about the user\'s email using your Gmail ' +
    'tools. ALWAYS call a tool to find out — never guess or describe mail you have not ' +
    'retrieved. When you list messages, give the sender and subject of each.',
  capabilities: { webBrowsing: false, codeInterpreter: false },
  starterPrompts: [],
  topics: [],
  knowledgeSources: [],
  unmapped: [],
};

const liveConnectors = [
  {
    id: 'shared_gmail',
    kind: 'gmail',
    name: 'Gmail',
    authKind: 'google-service-account',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
    secretIds: {
      service_account_json: 'studio-enterprise-shared-gmail-service-account-json',
      impersonate_email: 'studio-enterprise-shared-gmail-impersonate-email',
    },
    // Mirrors what a real migration passes: the Outlook operations the SOURCE agent used,
    // so the generated tool description reflects what the agent was built to do.
    operations: [
      { id: 'GetEmailsV3', description: 'Get emails' },
      { id: 'GetEmailV2', description: 'Get email' },
    ],
  },
];

const saToken = await getSaToken();

console.log('=== deploying agent with the Gmail connector ===');
const adk = await publishAgentToGallery(DEST, saToken, ir, { liveConnectors });
console.log(JSON.stringify(adk, null, 2));
if (!adk.ok || !adk.reasoningEngine) {
  console.log('\nVERDICT: FAIL — deploy did not succeed.');
  process.exit(0);
}

console.log('\nWaiting 10s for registration to settle...');
await new Promise((r) => setTimeout(r, 10_000));

const ask = async (message: string) => {
  const res = await fetch(
    `https://us-central1-aiplatform.googleapis.com/v1beta1/${adk.reasoningEngine}:streamQuery?alt=sse`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        class_method: 'stream_query',
        input: { user_id: 'gmail-equivalence-proof', message },
      }),
    },
  );
  const raw = await res.text();
  const ev = scanToolEvidence(raw);
  const text = [...raw.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => { try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]; } })
    .join('').trim();

  console.log(`\n>>> ${message}`);
  console.log(`    status=${res.status} toolCalled=${ev.called} toolSucceeded=${ev.succeeded}`);
  console.log(`    tools=${JSON.stringify(ev.names)}`);
  if (ev.error) console.log(`    TOOL ERROR: ${ev.error}`);
  console.log(`    answer: ${text.slice(0, 500)}`);
  return ev;
};

const a = await ask('How many labels are in my mailbox? Use your tools to check.');
const b = await ask('List my 3 most recent emails with sender and subject.');

const gmailFired = [...a.names, ...b.names].some((n) => n.startsWith('gmail_'));
const succeeded = a.succeeded || b.succeeded;

console.log('\n--- VERDICT ---');
console.log(`reasoning engine: ${adk.reasoningEngine}`);
console.log(`agent id        : ${adk.agentId}`);
if (gmailFired && succeeded) {
  console.log('PASS — a deployed agent called a gmail_* tool and it returned data.');
  console.log('       Outlook -> Gmail cross-vendor equivalence proven end to end.');
} else if (gmailFired) {
  console.log('PARTIAL — the gmail tool was CALLED but returned no successful response.');
  console.log('          Read the TOOL ERROR above: usually the secret grant to the RE service agent.');
} else {
  console.log('FAIL — no gmail_* tool was invoked. The model answered without the tools,');
  console.log('       or the tools did not survive into the pickle.');
}
process.exit(0);
