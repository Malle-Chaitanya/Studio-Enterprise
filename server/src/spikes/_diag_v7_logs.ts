/**
 * Check v7 RE logs + retry query with longer wait.
 * Run: cd server && npx tsx src/spikes/_diag_v7_logs.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const RE_ID = '3069750153087811584';
const tok = await getSaToken();
const RE_PATH = `projects/231705905417/locations/us-central1/reasoningEngines/${RE_ID}`;

// 1. Check RE metadata + classMethods
console.log('=== RE metadata ===');
const meta = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}`, {
  headers: { Authorization: `Bearer ${tok}` },
});
const mj = await meta.json() as Record<string, unknown>;
console.log('classMethods:', JSON.stringify(mj['classMethods']));
console.log('state:', mj['state']);

// 2. Wait 3 min then test query
console.log('\nWaiting 3 minutes for RE container to start...');
await new Promise(r => setTimeout(r, 3 * 60 * 1000));

console.log('\n=== Test stream_query (baseline) ===');
const r1 = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'stream_query', input: { user_id: 'test', message: 'what is the leave policy?' } }),
});
const t1 = await r1.text();
console.log(`stream_query: ${r1.status}`);
try {
  const j = JSON.parse(t1) as Record<string, unknown>;
  const text = ((j['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>>)?.map(p => p['text']).join('') ?? '';
  console.log('Answer:', text.slice(0, 300) || JSON.stringify(j).slice(0, 200));
} catch { console.log('Raw:', t1.slice(0, 400)); }

console.log('\n=== Test query ===');
const r2 = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'query', input: { user_id: 'test', message: 'what is the leave policy?' } }),
});
const t2 = await r2.text();
console.log(`query: ${r2.status}`);
try {
  const lines = t2.trim().split('\n').filter(Boolean);
  for (const line of lines) {
    const j = JSON.parse(line) as Record<string, unknown>;
    const content = j['content'] as Record<string, unknown> | undefined;
    const text = (content?.['parts'] as Array<Record<string, unknown>>)?.map(p => p['text']).join('') ?? '';
    if (text) { console.log('Answer:', text.slice(0, 300)); break; }
  }
  if (!t2.includes('"text"')) console.log('Raw:', t2.slice(0, 500));
} catch { console.log('Raw:', t2.slice(0, 500)); }

// 3. Check logs
console.log('\n=== RE logs (last 10 min) ===');
const lr = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: ['projects/studio-enterprise-migration'],
    filter: [
      'resource.type="aiplatform.googleapis.com/ReasoningEngine"',
      `resource.labels.reasoning_engine_id="${RE_ID}"`,
      `timestamp>="${new Date(Date.now() - 15 * 60 * 1000).toISOString()}"`,
    ].join('\n'),
    orderBy: 'timestamp desc',
    pageSize: 40,
  }),
});
const lj = await lr.json() as { entries?: Array<Record<string, unknown>> };
const skip = ['startup complete', 'is starting up', 'server process', 'Waiting for', 'telemetry', 'LoggerProvider', 'httpx', 'gRPC instrumentation', 'GenAI', 'TraceProvider'];
for (const e of lj.entries ?? []) {
  const pay = String(e['textPayload'] ?? JSON.stringify(e['jsonPayload'] ?? e['protoPayload'] ?? ''));
  if (skip.some(s => pay.includes(s))) continue;
  console.log(`[${String(e['timestamp']).slice(11, 19)}]: ${pay.slice(0, 800)}`);
}
