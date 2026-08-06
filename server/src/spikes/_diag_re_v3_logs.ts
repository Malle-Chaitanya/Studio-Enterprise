/**
 * Check Cloud Logging for v3 RE errors + try direct invocation.
 * RE: 8180209830246481920
 * Usage: cd server && npx tsx src/spikes/_diag_re_v3_logs.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT  = 'studio-enterprise-migration';
const SA_PROJ_NUM = '231705905417';
const RE_ID       = '8180209830246481920';
const RE_PATH     = `projects/${SA_PROJ_NUM}/locations/us-central1/reasoningEngines/${RE_ID}`;

const tok = await getSaToken();

// ── Cloud Logging ─────────────────────────────────────────────────────────────
console.log('=== Cloud Logging (last 30 min, RE errors) ===');
const now = new Date();
const t30 = new Date(now.getTime() - 30 * 60 * 1000);
const logRes = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${SA_PROJECT}`],
    filter: [
      `resource.type="aiplatform.googleapis.com/ReasoningEngine"`,
      `resource.labels.reasoning_engine_id="${RE_ID}"`,
      `timestamp>="${t30.toISOString()}"`,
    ].join('\n'),
    orderBy: 'timestamp desc',
    pageSize: 30,
  }),
});
const logJson = await logRes.json() as { entries?: Array<Record<string, unknown>> };
const entries = logJson.entries ?? [];
console.log(`${logRes.status} — ${entries.length} log entries`);
for (const e of entries) {
  const sev = e['severity'];
  const ts  = String(e['timestamp']).slice(11, 19);
  const pay = e['textPayload'] ?? e['jsonPayload'] ?? e['protoPayload'];
  console.log(`[${sev}] ${ts}: ${JSON.stringify(pay).slice(0, 400)}`);
}

// ── Direct RE invocation test ─────────────────────────────────────────────────
console.log('\n=== Direct RE invocation test ===');
// ADK agents respond to stream_query with specific session format
const formats = [
  {
    label: 'ADK session create',
    url: `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery?alt=sse`,
    body: { class_method: 'stream_query', input: { user_id: 'test', message: 'hello' } },
  },
  {
    label: 'plain stream_query',
    url: `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery`,
    body: { input: { user_id: 'test', message: 'hello' } },
  },
];

for (const { label, url, body } of formats) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  console.log(`[${label}] ${r.status}: ${text.slice(0, 300)}\n`);
}

// ── RE metadata ───────────────────────────────────────────────────────────────
console.log('=== RE metadata ===');
const meta = await fetch(
  `https://us-central1-aiplatform.googleapis.com/v1beta1/${RE_PATH}`,
  { headers: { Authorization: `Bearer ${tok}` } },
);
const metaJson = await meta.json() as Record<string, unknown>;
console.log(`state: ${JSON.stringify(metaJson['state'] ?? 'unknown')}`);
const classMethods = metaJson['classMethods'] as string[] | undefined;
console.log(`classMethods: ${JSON.stringify(classMethods?.slice(0, 5))}`);
