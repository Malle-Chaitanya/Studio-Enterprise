/**
 * Run the customer's REAL "Email Manager" agent through the pipeline — both mail paths.
 *
 * Everything before this was proven with agents I wrote. This one was built by hand in
 * Copilot Studio and is extracted live from Dataverse, so it can surprise us: its tools,
 * instructions and topics are whatever the author actually configured.
 *
 * It carries three connector operations, and the mix is the point:
 *   SendEmailV2              mail     — proven on both paths
 *   GetEmailsV3              mail     — proven on both paths
 *   GetEventsCalendarViewV3  CALENDAR — not mapped at all
 *
 * So a correct run must migrate two tools and REPORT THE THIRD AS LOST. An honest partial
 * is the pass condition; three green tools would mean we invented a calendar mapping.
 *
 * Deployed twice, once per destination the surface-choice screen offers, because "keep
 * Outlook" and "use Gmail" are both real answers and neither is a default:
 *   GMAIL   -> gmail.py tools against zara@storefuze.com
 *   OUTLOOK -> outlook.py tools against alex@filefuze.co via Graph
 *
 * A 200 is not proof and prose is not proof — the model can describe an inbox it never
 * read. Evidence is a `function_call` frame naming a tool plus a non-error
 * `function_response`, read structurally the way verify.ts does it.
 *
 *   cd server && npx tsx src/spikes/_e2e_email_manager.ts [gmail|outlook|both]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { getSaToken } from '../auth/google.js';
import { publishAgentToGallery } from '../services/adkDeployer.js';
import { scanToolEvidence } from '../services/adkAgentChat.js';
import { findEquivalence } from '../connectors/equivalence.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import type { GeminiDestination } from '../types.js';

const WHICH = (process.argv[2] || 'both').toLowerCase();
const ENV = 'https://org32322095.crm.dynamics.com';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};

// ---- 1. extract the real agent -------------------------------------------------------
await connectMongo();
const envRow = (await getDb()
  .collection('environmentsCache')
  .find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as { tenantId?: string } | null;
const msToken = await clientCredsToken(envRow!.tenantId!, ENV);
const bots = await listBots(ENV, msToken);
const bot = bots.find((b) => b.name.trim().toLowerCase() === 'email manager');
if (!bot) {
  console.log('FAIL: no bot named "Email Manager" in this environment.');
  process.exit(0);
}

const ir = await extractAgent(ENV, msToken, bot);
const tools = ir.agentTools ?? [];
console.log(`\n=== EXTRACTED: ${ir.name} ===`);
console.log(`  sourceId     : ${ir.sourceId}`);
console.log(`  instructions : ${ir.instructions?.length ?? 0} chars`);
console.log(`  topics       : ${ir.topics?.length ?? 0}`);
console.log(`  tools        : ${tools.length}`);

// ---- 2. decide what each tool becomes, honestly ---------------------------------------
const migrating: { id: string; description: string }[] = [];
const lost: string[] = [];
for (const t of tools) {
  const op = t.operationId ?? '';
  const eq = findEquivalence('outlook', op);
  if (eq && eq.fidelity !== 'lost') {
    migrating.push({ id: op, description: t.name ?? op });
    console.log(`  MIGRATES  ${op.padEnd(24)} ${eq.fidelity}`);
  } else {
    lost.push(op);
    const why = eq ? eq.reason?.slice(0, 60) : 'not in the equivalence table (calendar is out of scope)';
    console.log(`  LOST      ${op.padEnd(24)} ${why}`);
  }
}
if (migrating.length === 0) {
  console.log('\nFAIL: nothing to migrate.');
  process.exit(0);
}

const saToken = await getSaToken();

// Built FROM THE REGISTRY, not by hand. The first version of this spike hand-wrote each
// spec and silently omitted `tokenUrlTemplate`, so the container had no token endpoint and
// every Outlook call failed auth inside a deployed agent. The registry already holds the
// right values for both connectors; only the per-agent secret ids belong here.
const SECRETS: Record<string, Record<string, string>> = {
  shared_gmail: {
    service_account_json: 'studio-enterprise-shared-gmail-service-account-json',
    impersonate_email: 'studio-enterprise-shared-gmail-impersonate-email',
  },
  shared_outlook: {
    tenant_id: 'studio-enterprise-ms-graph-tenant-id',
    client_id: 'studio-enterprise-ms-graph-client-id',
    client_secret: 'studio-enterprise-ms-graph-client-secret',
    impersonate_email: 'studio-enterprise-shared-outlook-impersonate-email',
  },
};

function specFor(connectorId: string) {
  const def = REGISTRY_BY_ID.get(connectorId);
  if (!def) throw new Error(`${connectorId} is not in the registry`);
  return {
    id: def.id,
    kind: connectorId === 'shared_gmail' ? 'gmail' : 'outlook',
    name: def.name,
    secretIds: SECRETS[connectorId],
    authKind: def.authKind,
    scope: def.scope,
    baseUrlTemplate: def.baseUrlTemplate,
    authHeaderTemplate: def.authHeaderTemplate,
    tokenUrlTemplate: def.tokenUrlTemplate,
    operations: migrating,
  };
}

const CONNECTORS = {
  gmail: specFor('shared_gmail'),
  outlook: specFor('shared_outlook'),
};

// The source agent has no instructions of its own (0 chars — the author configured tools
// only), so the tool-calling discipline has to come from here. Stated explicitly rather
// than assumed: a model with mail tools and no instructions will happily answer from
// memory.
const baseInstructions = ir.instructions?.trim() || 'You are an email assistant.';
const instructions =
  baseInstructions +
  '\n\nALWAYS call a tool to find out about mail — never guess or describe messages you ' +
  'have not retrieved. When you list messages, give the sender and subject of each.' +
  (lost.length
    ? '\n\nYou do NOT have calendar access. If asked about calendar events, say so plainly.'
    : '');

async function runPath(kind: 'gmail' | 'outlook') {
  const conn = CONNECTORS[kind];
  console.log(`\n\n########## PATH: ${kind.toUpperCase()} ##########`);
  const deployIr = {
    ...ir,
    sourceId: `${ir.sourceId}-${kind}`,
    name: `Email Manager (${kind === 'gmail' ? 'Gmail' : 'Outlook'})`,
    instructions,
    capabilities: { webBrowsing: false, codeInterpreter: false },
    starterPrompts: [],
    topics: [],
    knowledgeSources: [],
    unmapped: [],
  };
  const adk = await publishAgentToGallery(DEST, saToken, deployIr as never, {
    liveConnectors: [conn as never],
  });
  const iam = (adk as { secretIamGranted?: boolean }).secretIamGranted;
  console.log(`  ok=${adk.ok} re=${adk.reasoningEngine ?? '-'} secretIam=${iam}`);
  if (!adk.ok || !adk.reasoningEngine) {
    console.log(`  DEPLOY FAILED: ${JSON.stringify(adk).slice(0, 400)}`);
    return null;
  }

  await new Promise((r) => setTimeout(r, 10_000));

  const ask = async (message: string) => {
    const res = await fetch(
      `https://us-central1-aiplatform.googleapis.com/v1beta1/${adk.reasoningEngine}:streamQuery?alt=sse`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          class_method: 'stream_query',
          input: { user_id: 'email-manager-e2e', message },
        }),
      },
    );
    const raw = await res.text();
    const ev = scanToolEvidence(raw);
    const text = [...raw.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)]
      .map((m) => {
        try {
          return JSON.parse(`"${m[1]}"`) as string;
        } catch {
          return m[1];
        }
      })
      .join('')
      .trim();
    console.log(`\n  >>> ${message}`);
    console.log(`      toolCalled=${ev.called} succeeded=${ev.succeeded} tools=${JSON.stringify(ev.names)}`);
    if (ev.error) console.log(`      TOOL ERROR: ${ev.error}`);
    console.log(`      answer: ${text.slice(0, 420)}`);
    return ev;
  };

  const a = await ask('List my 3 most recent emails with sender and subject.');
  // The lost tool, asked directly. The right answer is an honest refusal, not an invention.
  const b = await ask('What meetings do I have on my calendar tomorrow?');
  return { adk, a, b };
}

const results: Record<string, Awaited<ReturnType<typeof runPath>>> = {};
if (WHICH === 'both' || WHICH === 'gmail') results.gmail = await runPath('gmail');
if (WHICH === 'both' || WHICH === 'outlook') results.outlook = await runPath('outlook');

console.log('\n\n=========== VERDICT ===========');
console.log(
  `source agent : ${ir.name} (${tools.length} tools: ${migrating.length} migrating, ${lost.length} lost)`,
);
for (const [kind, r] of Object.entries(results)) {
  if (!r) {
    console.log(`${kind.padEnd(8)} FAIL — did not deploy`);
    continue;
  }
  const prefix = kind === 'gmail' ? 'gmail_' : 'outlook_';
  const fired = r.a.names.some((n) => n.startsWith(prefix));
  const calendarInvented = r.b.names.length > 0 && r.b.succeeded;
  console.log(`${kind.padEnd(8)} re=${r.adk.reasoningEngine}`);
  console.log(`         mail tool fired=${fired} succeeded=${r.a.succeeded}`);
  console.log(`         calendar question answered WITHOUT inventing a tool=${!calendarInvented}`);
  console.log(`         ${fired && r.a.succeeded && !calendarInvented ? 'PASS' : 'REVIEW'}`);
}
process.exit(0);
