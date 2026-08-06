/**
 * v8: Deploy RE with ReasoningEngineAgentWrapper (standalone class, NOT AdkApp subclass).
 *
 * Hypothesis: RE runtime restricts AdkApp *subclasses* to its 3-method whitelist.
 * A generic class (object base) gets dynamic method introspection — all public
 * methods discovered, including query().
 *
 * Run: cd server && npx tsx src/spikes/_test_adk_v8.ts
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';

const execFileAsync = promisify(execFile);

const PROJECT     = 'studio-enterprise-migration';
const LOCATION    = 'us-central1';
const DATA_STORE  = `projects/${PROJECT}/locations/global/collections/default_collection/dataStores/cf-knowledge-eng-hr`;
const BUCKET      = `gs://${PROJECT}-adk-staging`;
const GCP_PROJECT = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const SA_PROJECT_NUM = '231705905417';

const spec = {
  name: 'confluence_knowledge_v8',
  displayName: 'Confluence Knowledge Agent v8',
  description: 'Grounded on Confluence ENG+HR knowledge (ReasoningEngineAgentWrapper — standalone class)',
  model: 'gemini-2.5-flash',
  instruction: 'You are a helpful assistant. Use the knowledge tool to find accurate answers. Always cite your sources.',
  groundingDataStores: [DATA_STORE],
};

const saToken = await getSaToken();

// ── Step 0: delete same-project RE from earlier ECONNRESET test (optional cleanup) ──
const OLD_SAME_PROJECT_RE = '2645285888208142336';
console.log('[0] Checking old same-project RE...');
try {
  const r = await fetch(
    `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${SA_PROJECT_NUM}/locations/us-central1/reasoningEngines/${OLD_SAME_PROJECT_RE}`,
    { headers: { Authorization: `Bearer ${saToken}` } }
  );
  if (r.ok) {
    console.log(`  Found old RE ${OLD_SAME_PROJECT_RE} — deleting to save quota...`);
    const dr = await fetch(
      `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${SA_PROJECT_NUM}/locations/us-central1/reasoningEngines/${OLD_SAME_PROJECT_RE}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } }
    );
    console.log(`  Delete: ${dr.status}`);
  } else {
    console.log(`  Old RE ${OLD_SAME_PROJECT_RE} already gone (${r.status})`);
  }
} catch (e) { console.log(`  Skip: ${e}`); }

// ── Step 1: Deploy v8 RE using updated adk_deploy.py ──
console.log('\n[1] Deploying RE v8 (ReasoningEngineAgentWrapper — standalone class)...');
const scriptPath = new URL('../../scripts/adk_deploy.py', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1');
let reId = '';
try {
  const { stdout, stderr } = await execFileAsync('python', [
    scriptPath,
    '--project', PROJECT,
    '--location', LOCATION,
    '--staging-bucket', BUCKET,
    '--spec', JSON.stringify(spec),
  ], { timeout: 10 * 60 * 1000 });

  if (stderr) console.log(`  deploy stderr: ${stderr.slice(0, 400)}`);
  const lines = stdout.trim().split('\n');
  const last = lines[lines.length - 1];
  console.log(`  deploy stdout: ${last}`);
  const out = JSON.parse(last) as { reasoningEngine?: string; error?: string };
  if (out.error) { console.error(`  DEPLOY ERROR: ${out.error}`); process.exit(1); }
  reId = out.reasoningEngine!.split('/').pop()!;
  console.log(`  RE v8 deployed: ${out.reasoningEngine} ✓`);
} catch (e) { console.error(`  deploy failed: ${e}`); process.exit(1); }

const RE_PATH = `projects/${SA_PROJECT_NUM}/locations/${LOCATION}/reasoningEngines/${reId}`;

// ── Step 2: Check RE metadata + classMethods ──
console.log('\n[2] Checking RE v8 metadata...');
const metaR = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
const metaJ = await metaR.json() as Record<string, unknown>;
console.log(`  classMethods: ${JSON.stringify(metaJ['classMethods'])}`);
console.log(`  state: ${metaJ['state']}`);

// ── Step 3: Wait for container to warm up ──
console.log('\n[3] Waiting 5 minutes for RE container to be ready...');
await new Promise(r => setTimeout(r, 5 * 60 * 1000));

// ── Step 4: Test query directly (the Agentspace path) ──
console.log('\n[4] Testing class_method=query (Agentspace path)...');
const qr = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    class_method: 'query',
    input: { user_id: 'test-v8', message: 'What is the leave policy for sick leave?' },
  }),
});
const qt = await qr.text();
console.log(`  query status: ${qr.status}`);
if (qr.ok) {
  try {
    // streamQuery returns newline-delimited JSON
    const lines = qt.trim().split('\n').filter(Boolean);
    for (const line of lines) {
      const j = JSON.parse(line) as Record<string, unknown>;
      const parts = ((j['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>>) ?? [];
      const text = parts.map(p => p['text']).join('');
      if (text) { console.log(`  Answer (query): ${text.slice(0, 300)}`); break; }
    }
    if (!qt.includes('"text"')) console.log(`  Raw: ${qt.slice(0, 300)}`);
  } catch { console.log(`  Raw: ${qt.slice(0, 400)}`); }
} else {
  console.log(`  Error: ${qt.slice(0, 500)}`);
}

// ── Step 5: Test stream_query (baseline) ──
console.log('\n[5] Testing class_method=stream_query (baseline)...');
const sr = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    class_method: 'stream_query',
    input: { user_id: 'test-v8', message: 'What is the leave policy for sick leave?' },
  }),
});
const st = await sr.text();
console.log(`  stream_query status: ${sr.status}`);
if (sr.ok) {
  try {
    const j = JSON.parse(st) as Record<string, unknown>;
    const text = ((j['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>>)?.map(p => p['text']).join('') ?? '';
    console.log(`  Answer (stream_query): ${text.slice(0, 300) || JSON.stringify(j).slice(0, 200)}`);
  } catch { console.log(`  Raw: ${st.slice(0, 400)}`); }
} else {
  console.log(`  Error: ${st.slice(0, 400)}`);
}

// ── Step 6: Fetch RE logs ──
console.log('\n[6] RE logs (last 15 min)...');
const lr = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${PROJECT}`],
    filter: [
      'resource.type="aiplatform.googleapis.com/ReasoningEngine"',
      `resource.labels.reasoning_engine_id="${reId}"`,
      `timestamp>="${new Date(Date.now() - 15 * 60 * 1000).toISOString()}"`,
    ].join('\n'),
    orderBy: 'timestamp desc',
    pageSize: 40,
  }),
});
const lj = await lr.json() as { entries?: Array<Record<string, unknown>> };
const skip = ['startup complete', 'is starting up', 'server process', 'Waiting for',
  'telemetry', 'LoggerProvider', 'httpx', 'gRPC', 'GenAI', 'TraceProvider', 'instrumentation'];
for (const e of lj.entries ?? []) {
  const pay = String(e['textPayload'] ?? JSON.stringify(e['jsonPayload'] ?? e['protoPayload'] ?? ''));
  if (skip.some(s => pay.includes(s))) continue;
  console.log(`[${String(e['timestamp']).slice(11, 19)}]: ${pay.slice(0, 800)}`);
}

// ── Step 7: If query works, register as Agentspace agent ──
if (qr.ok) {
  console.log('\n[7] query() WORKS! Registering as Agentspace agent...');
  const agentToken = await getSaToken(GEMINI_ADMIN);
  const dest = await resolveDestination(GCP_PROJECT, agentToken);
  const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
  const base = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;

  const rr = await fetch(`${base}/agents`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      displayName: 'Confluence Knowledge Agent v8',
      description: 'Knowledge agent — standalone wrapper, query() enabled',
      adkAgentDefinition: {
        provisionedReasoningEngine: { reasoningEngine: RE_PATH },
      },
    }),
  });
  const rt = await rr.text();
  console.log(`  Register: ${rr.status}`);
  if (rr.ok) {
    const rj = JSON.parse(rt) as Record<string, unknown>;
    const agentId = String(rj['name']).split('/').pop();
    console.log(`  Agent ID: ${agentId}, State: ${rj['state']}`);

    await fetch(`${base}/agents/${agentId}?updateMask=sharingConfig`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${agentToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
    }).then(r => console.log(`  Share: ${r.status}`));

    console.log(`\n=== SUCCESS ===`);
    console.log(`Agent ID: ${agentId}`);
    console.log(`RE: ${RE_PATH}`);
    console.log(`Test: business.gemini.google → "What is the sick leave policy?"`);
  } else {
    console.log(`  Register error: ${rt.slice(0, 400)}`);
  }
} else {
  console.log(`\n[7] query() failed — RE: ${RE_PATH}`);
  console.log(`    stream_query ${sr.ok ? 'WORKS' : 'also failed'}`);
  console.log(`    Check logs above for "Available methods" to confirm method discovery`);
}
