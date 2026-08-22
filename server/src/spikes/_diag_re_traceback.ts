/**
 * Get the REAL traceback out of a crashing Reasoning Engine.
 *
 * `adkChat` surfaces only the error event's `errorCode`/`errorMessage`
 * ("TypeError: 'NoneType' object is not subscriptable") — enough to know the container
 * raised, useless for knowing where. This queries the RE directly and dumps the raw stream,
 * then pulls Cloud Logging for the same engine, because the traceback lands in one or the
 * other depending on whether ADK caught the exception or the process did.
 *
 * Usage: cd server && npx tsx src/spikes/_diag_re_traceback.ts <reasoningEngineId> [location] [question]
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const RE_ID = process.argv[2] ?? '1427317275702067200';
const LOCATION = process.argv[3] ?? 'us-central1';
const QUESTION = process.argv[4] ?? 'Briefly, what can you help me with?';
const PROJECT_NUM = '231705905417';
const RE_PATH = `projects/${PROJECT_NUM}/locations/${LOCATION}/reasoningEngines/${RE_ID}`;

const token = await getSaToken();

// ── 1. The engine's own spec — which class methods does it expose? ────────────
console.log('=== RE spec ===');
const specRes = await fetch(`https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${RE_PATH}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const spec = (await specRes.json()) as Record<string, unknown>;
console.log(`status ${specRes.status}`);
console.log(JSON.stringify({
  displayName: spec.displayName,
  updateTime: spec.updateTime,
  methods: ((spec.spec as { classMethods?: Array<{ name?: string }> })?.classMethods ?? []).map((m) => m.name),
}, null, 2));

// ── 2. Query it and keep the WHOLE stream, error frames included ──────────────
console.log('\n=== streamQuery raw ===');
const qRes = await fetch(`https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${RE_PATH}:streamQuery?alt=sse`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    class_method: 'stream_query',
    input: { user_id: 'cf-traceback-probe', message: QUESTION },
  }),
});
const raw = await qRes.text();
console.log(`status ${qRes.status}, ${raw.length} chars`);

// Print any frame that smells like a failure, with context, rather than the whole stream.
const interesting = raw
  .split('\n')
  .filter((l) => /error|Error|Traceback|NoneType|subscriptable|exception/i.test(l));
if (interesting.length) {
  console.log('\n--- error frames ---');
  for (const l of interesting.slice(0, 20)) console.log(l.slice(0, 2000));
} else {
  console.log('\n--- no error frames; first 2000 chars ---');
  console.log(raw.slice(0, 2000));
}

// ── 3. Cloud Logging for this engine ─────────────────────────────────────────
// The container's stderr is where a Python traceback actually lands. Severity is left
// unfiltered on purpose: this runtime has logged tool errors at INFO before, so filtering
// to >=WARNING has previously hidden exactly the entries worth reading.
console.log('\n=== Cloud Logging ===');
const logRes = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${PROJECT_NUM}`],
    filter: `resource.labels.reasoning_engine_id="${RE_ID}" AND timestamp>="${new Date(Date.now() - 3600_000).toISOString()}"`,
    orderBy: 'timestamp desc',
    pageSize: 40,
  }),
});
const logJson = (await logRes.json()) as { entries?: Array<Record<string, unknown>>; error?: unknown };
console.log(`status ${logRes.status}`);
if (logJson.error) console.log(JSON.stringify(logJson.error).slice(0, 500));
const entries = logJson.entries ?? [];
console.log(`${entries.length} entr(ies)`);
for (const e of entries) {
  const payload = (e.textPayload as string) ?? JSON.stringify(e.jsonPayload ?? {});
  if (!payload || payload === '{}') continue;
  console.log(`[${String(e.severity ?? '?')}] ${payload.slice(0, 1200)}`);
}
process.exit(0);
