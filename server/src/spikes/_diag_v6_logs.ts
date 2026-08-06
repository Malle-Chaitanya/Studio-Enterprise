/**
 * Check v6 RE logs — what happens when query() is called.
 * Run: cd server && npx tsx src/spikes/_diag_v6_logs.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const RE_ID = '478491517489512448';
const tok = await getSaToken();

// 1. Check RE classMethods
console.log('=== RE metadata ===');
const meta = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/projects/231705905417/locations/us-central1/reasoningEngines/${RE_ID}`, {
  headers: { Authorization: `Bearer ${tok}` },
});
const mj = await meta.json() as Record<string, unknown>;
console.log('classMethods:', JSON.stringify(mj['classMethods']));
console.log('state:', mj['state']);

// 2. Try query with different input format (what Agentspace likely sends)
console.log('\n=== Test: query with message only ===');
const r1 = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/projects/231705905417/locations/us-central1/reasoningEngines/${RE_ID}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'query', input: { message: 'what is the leave policy?' } }),
});
const t1 = await r1.text();
console.log(`Status: ${r1.status}`);
console.log(`Body: ${t1.slice(0, 600)}`);

// 3. Try stream_query (baseline — should still work)
console.log('\n=== Test: stream_query (baseline) ===');
const r2 = await fetch(`https://us-central1-aiplatform.googleapis.com/v1beta1/projects/231705905417/locations/us-central1/reasoningEngines/${RE_ID}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ class_method: 'stream_query', input: { user_id: 'test', message: 'what is the leave policy?' } }),
});
const t2 = await r2.text();
console.log(`Status: ${r2.status}`);
try {
  const j = JSON.parse(t2) as Record<string, unknown>;
  const text = ((j['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>>)?.map(p => p['text']).join('') ?? '';
  console.log('Answer:', text.slice(0, 300) || JSON.stringify(j).slice(0, 300));
} catch { console.log('Raw:', t2.slice(0, 600)); }

// 4. Check logs
console.log('\n=== RE execution logs (last 10 min) ===');
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
    pageSize: 50,
  }),
});
const lj = await lr.json() as { entries?: Array<Record<string, unknown>> };
const skip = ['startup complete', 'is starting up', 'server process', 'Waiting for', 'telemetry', 'LoggerProvider', 'httpx instrumentation', 'gRPC instrumentation', 'GenAI instrumentation', 'TraceProvider'];
for (const e of lj.entries ?? []) {
  const pay = String(e['textPayload'] ?? JSON.stringify(e['jsonPayload'] ?? e['protoPayload'] ?? ''));
  if (skip.some(s => pay.includes(s))) continue;
  console.log(`[${String(e['timestamp']).slice(11, 19)}]: ${pay.slice(0, 800)}`);
}
