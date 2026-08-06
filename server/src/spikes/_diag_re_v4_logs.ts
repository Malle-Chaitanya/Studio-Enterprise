/**
 * Check Cloud Logging for v4 RE + direct invocation test.
 * RE: 6740183849394765824
 * Usage: cd server && npx tsx src/spikes/_diag_re_v4_logs.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT  = 'studio-enterprise-migration';
const SA_PROJ_NUM = '231705905417';
const RE_ID       = '6740183849394765824';
const RE_PATH     = `projects/${SA_PROJ_NUM}/locations/us-central1/reasoningEngines/${RE_ID}`;

const tok = await getSaToken();

// ── Cloud Logging ─────────────────────────────────────────────────────────────
console.log('=== Cloud Logging (last 2h) ===');
const t2h = new Date(Date.now() - 2 * 60 * 60 * 1000);
const logRes = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${SA_PROJECT}`],
    filter: [
      `resource.type="aiplatform.googleapis.com/ReasoningEngine"`,
      `resource.labels.reasoning_engine_id="${RE_ID}"`,
      `timestamp>="${t2h.toISOString()}"`,
    ].join('\n'),
    orderBy: 'timestamp desc',
    pageSize: 30,
  }),
});
const logJson = await logRes.json() as { entries?: Array<Record<string, unknown>> };
const entries = logJson.entries ?? [];
console.log(`${logRes.status} — ${entries.length} log entries`);
for (const e of entries) {
  const sev = e['severity'] ?? '?';
  const ts  = String(e['timestamp']).slice(11, 19);
  const pay = e['textPayload'] ?? e['jsonPayload'] ?? e['protoPayload'];
  const text = JSON.stringify(pay).slice(0, 500);
  console.log(`[${sev}] ${ts}: ${text}`);
}

// ── Direct invocation test ─────────────────────────────────────────────────────
console.log('\n=== Direct RE invocation (ADK session format) ===');
const r = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery?alt=sse`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'stream_query', input: { user_id: 'test', message: 'what is the leave policy?' } }),
  },
);
const text = await r.text();
console.log(`Status: ${r.status}`);
console.log(`Response (first 600): ${text.slice(0, 600)}`);
