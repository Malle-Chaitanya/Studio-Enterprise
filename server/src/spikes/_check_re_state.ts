/**
 * Check v8 RE state and test direct invocation.
 * Run: cd server && npx tsx src/spikes/_check_re_state.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT_NUM = '231705905417';
const SA_PROJECT = 'studio-enterprise-migration';
const V8_RE_ID = '8175706230619111424';
const RE_PATH = `projects/${SA_PROJECT_NUM}/locations/us-central1/reasoningEngines/${V8_RE_ID}`;
const RE_HOST = 'https://us-central1-aiplatform.googleapis.com/v1beta1';

const token = await getSaToken();

// ── Step 1: Check RE metadata ─────────────────────────────────────────────────
console.log('[1] RE metadata...');
const mr = await fetch(`${RE_HOST}/${RE_PATH}`, { headers: { Authorization: `Bearer ${token}` } });
const mj = await mr.json() as Record<string, unknown>;
console.log(`  status: ${mr.status}`);
console.log(`  state: ${mj['state']}`);
console.log(`  displayName: ${mj['displayName']}`);
console.log(`  createTime: ${mj['createTime']}`);
console.log(`  classMethods: ${JSON.stringify(mj['classMethods'])}`);

// ── Step 2: Test direct stream_query (confirm RE is alive) ────────────────────
console.log('\n[2] Testing stream_query directly...');
const sr = await fetch(`${RE_HOST}/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    class_method: 'stream_query',
    input: { user_id: 'check-state', message: 'What is the sick leave policy?' },
  }),
});
const st = await sr.text();
console.log(`  stream_query status: ${sr.status}`);
if (sr.ok) {
  const lines = st.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    try {
      const j = JSON.parse(line) as Record<string, unknown>;
      const parts = ((j['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>>) ?? [];
      const text = parts.map(p => p['text']).join('');
      if (text) { console.log(`  Answer: ${text.slice(0, 200)}`); break; }
    } catch { /* skip */ }
  }
  if (!st.includes('"text"')) {
    console.log(`  Raw: ${st.slice(0, 300)}`);
  }
} else {
  console.log(`  Error: ${st.slice(0, 400)}`);
}

// ── Step 3: Check recent RE logs ─────────────────────────────────────────────
console.log('\n[3] Recent RE logs (last 2 hours)...');
const since = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const lr = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${SA_PROJECT}`],
    filter: [
      'resource.type="aiplatform.googleapis.com/ReasoningEngine"',
      `resource.labels.reasoning_engine_id="${V8_RE_ID}"`,
      `timestamp>="${since}"`,
    ].join('\n'),
    orderBy: 'timestamp desc',
    pageSize: 20,
  }),
});
const lj = await lr.json() as { entries?: Array<Record<string, unknown>> };
const entries = lj.entries ?? [];
console.log(`  Found ${entries.length} log entries`);

const skip = ['startup', 'telemetry', 'LoggerProvider', 'GenAI', 'TraceProvider', 'instrumentation', 'FutureWarning'];
for (const e of entries.slice(0, 10)) {
  const pay = String(e['textPayload'] ?? JSON.stringify(e['jsonPayload'] ?? ''));
  if (skip.some(s => pay.includes(s))) continue;
  console.log(`  [${String(e['timestamp']).slice(11, 19)}] ${pay.slice(0, 300)}`);
}

// ── Step 4: Check v1 (non-beta) RE endpoint ───────────────────────────────────
console.log('\n[4] Checking v1 (GA) RE...');
const v1r = await fetch(`https://us-central1-aiplatform.googleapis.com/v1/${RE_PATH}`, {
  headers: { Authorization: `Bearer ${token}` }
});
console.log(`  v1 status: ${v1r.status}`);
if (v1r.ok) {
  const v1j = await v1r.json() as Record<string, unknown>;
  console.log(`  v1 state: ${v1j['state']}`);
  console.log(`  v1 classMethods: ${JSON.stringify(v1j['classMethods'])}`);
}
