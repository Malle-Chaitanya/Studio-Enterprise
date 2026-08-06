/**
 * Register the existing v8 RE as an Agentspace agent, then check what
 * class_method Agentspace actually uses when a user chats with it.
 *
 * Critical question: does Agentspace send class_method='query' or 'stream_query'?
 * Our manual tests used 'query' (which fails). If Agentspace sends 'stream_query'
 * internally, the agent would work fine.
 *
 * Run: cd server && npx tsx src/spikes/_test_register_v8_agent.ts
 * Then: open business.gemini.google, find "Confluence Knowledge Agent v8-reg",
 *       ask "What is the sick leave policy?", come back to check logs.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const GCP_PROJECT = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const SA_PROJECT_NUM = '231705905417';
const SA_PROJECT = 'studio-enterprise-migration';
const LOCATION = 'us-central1';

// v8 RE deployed in previous test
const V8_RE_ID = '8175706230619111424';
const V8_RE_PATH = `projects/${SA_PROJECT_NUM}/locations/${LOCATION}/reasoningEngines/${V8_RE_ID}`;

const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const RE_HOST = 'https://us-central1-aiplatform.googleapis.com/v1beta1';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest = await resolveDestination(GCP_PROJECT, saToken);
console.log(`Destination: project=${dest.project} engine=${dest.engine}`);

const assistantBase = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;
const agentBase = `${assistantBase}/agents`;

// ── Step 1: Verify v8 RE still exists ────────────────────────────────────────
console.log('\n[1] Checking v8 RE still exists...');
const reCheckToken = await getSaToken(); // SA token (not DWD) for studio-enterprise-migration
const re8r = await fetch(`${RE_HOST}/${V8_RE_PATH}`, {
  headers: { Authorization: `Bearer ${reCheckToken}` },
});
if (!re8r.ok) {
  console.error(`  v8 RE not found (${re8r.status}): ${await re8r.text()}`);
  console.error('  Run _test_adk_v8.ts first to deploy it.');
  process.exit(1);
}
const re8j = await re8r.json() as Record<string, unknown>;
console.log(`  v8 RE state: ${re8j['state'] ?? 'unknown'}`);
console.log(`  v8 RE displayName: ${re8j['displayName'] ?? 'unknown'}`);

// ── Step 2: Register v8 RE as Agentspace agent ────────────────────────────────
console.log('\n[2] Registering v8 RE as Agentspace agent...');
const rr = await fetch(agentBase, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    displayName: 'Confluence Knowledge Agent v8-reg',
    description: 'ADK agent backed by v8 RE (standalone wrapper). Tests what class_method Agentspace sends.',
    adkAgentDefinition: {
      provisionedReasoningEngine: { reasoningEngine: V8_RE_PATH },
    },
  }),
});
const rt = await rr.text();
console.log(`  Register status: ${rr.status}`);
if (!rr.ok) {
  console.error(`  Register failed: ${rt.slice(0, 400)}`);
  process.exit(1);
}
const rj = JSON.parse(rt) as Record<string, unknown>;
const agentId = String(rj['name']).split('/').pop();
const state = rj['state'];
console.log(`  Agent ID: ${agentId}`);
console.log(`  State: ${state}`);

// ── Step 3: Share the agent ───────────────────────────────────────────────────
console.log('\n[3] Sharing agent with all users...');
const sr = await fetch(`${agentBase}/${agentId}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
console.log(`  Share status: ${sr.status}`);

// ── Step 4: Wait for RE logs after Agentspace interaction ─────────────────────
console.log('\n════════════════════════════════════════════════════════════════');
console.log('✅ Agent registered! Now:');
console.log('   1. Open https://business.gemini.google');
console.log('   2. Find agent "Confluence Knowledge Agent v8-reg"');
console.log(`   3. State should be: ${state} (if ENABLED, it appears in Agentspace)`);
console.log('   4. Ask: "What is the sick leave policy?"');
console.log('   5. Note what happens (answer or "Something went wrong")');
console.log('════════════════════════════════════════════════════════════════');
console.log('\n[4] Waiting 3 minutes then checking RE logs for class_method used...');
await new Promise(r => setTimeout(r, 3 * 60 * 1000));

// Check what class_method was actually used by Agentspace
console.log('\n[5] Fetching RE logs (last 5 minutes)...');
const since = new Date(Date.now() - 5 * 60 * 1000).toISOString();
const lr = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${reCheckToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${SA_PROJECT}`],
    filter: [
      'resource.type="aiplatform.googleapis.com/ReasoningEngine"',
      `resource.labels.reasoning_engine_id="${V8_RE_ID}"`,
      `timestamp>="${since}"`,
    ].join('\n'),
    orderBy: 'timestamp desc',
    pageSize: 50,
  }),
});
const lj = await lr.json() as { entries?: Array<Record<string, unknown>> };
const entries = lj.entries ?? [];
console.log(`  Found ${entries.length} log entries`);

const interestingPatterns = ['method', 'query', 'class_method', 'stream_query', 'invocation', 'POST', 'request'];
let foundMethodCall = false;
for (const e of entries) {
  const pay = String(e['textPayload'] ?? JSON.stringify(e['jsonPayload'] ?? e['protoPayload'] ?? ''));
  if (interestingPatterns.some(p => pay.toLowerCase().includes(p))) {
    console.log(`[${String(e['timestamp']).slice(11, 19)}]: ${pay.slice(0, 600)}`);
    if (pay.includes('class_method') || pay.includes('stream_query') || pay.includes('query')) {
      foundMethodCall = true;
    }
  }
}

if (!foundMethodCall) {
  console.log('\n  No query logs found — agent may not have been tested yet.');
  console.log('  Check logs manually: gcloud logging read --project studio-enterprise-migration \\');
  console.log(`    "resource.type=aiplatform.googleapis.com/ReasoningEngine AND resource.labels.reasoning_engine_id=${V8_RE_ID}"`);
} else {
  console.log('\n  ✅ Found method invocation logs above — check class_method used');
}

console.log(`\nAgent: ${agentBase}/${agentId}`);
console.log(`RE:    ${RE_HOST}/${V8_RE_PATH}`);
