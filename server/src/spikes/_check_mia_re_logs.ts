/**
 * Check logs for the new mia-project RE (5081170336662159360).
 * Different error: FAILED_PRECONDITION with empty Error Details — need logs to diagnose.
 *
 * Run: cd server && npx tsx src/spikes/_check_mia_re_logs.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const MIA_PROJECT = 'studioenterprisemigrations';
const MIA_PROJECT_NUM = '397459811728';
const RE_ID = '5081170336662159360';
const LOCATION = 'us-central1';
const HOST = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1`;
const RE_PATH = `projects/${MIA_PROJECT_NUM}/locations/${LOCATION}/reasoningEngines/${RE_ID}`;

const miaToken = await getSaToken('mia@cloudfuze.com');

// ── 1. Read Cloud Logging ─────────────────────────────────────────────────────
console.log('[1] Reading Cloud Logging for mia RE...');
const now = new Date();
const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
const filter = [
  `resource.type="aiplatform.googleapis.com/ReasoningEngine"`,
  `resource.labels.reasoning_engine_id="${RE_ID}"`,
  `timestamp>="${oneHourAgo}"`,
].join('\n');

const logR = await fetch(
  `https://logging.googleapis.com/v2/entries:list`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceNames: [`projects/${MIA_PROJECT_NUM}`],
      filter,
      orderBy: 'timestamp desc',
      pageSize: 20,
    }),
  }
);
const logJ = await logR.json() as { entries?: Array<{
  timestamp?: string;
  severity?: string;
  textPayload?: string;
  jsonPayload?: Record<string, unknown>;
  httpRequest?: Record<string, unknown>;
}> };
console.log(`  Log status: ${logR.status}, entries: ${logJ.entries?.length ?? 0}`);
for (const e of logJ.entries ?? []) {
  const ts = e.timestamp?.slice(11, 19) ?? '';
  const text = e.textPayload ?? JSON.stringify(e.jsonPayload ?? '');
  console.log(`  [${ts}] ${e.severity ?? ''}: ${text.slice(0, 200)}`);
}

// ── 2. Test stream_query with real question (verify grounding works) ───────────
console.log('\n[2] Testing stream_query with real Confluence question...');
const sqr = await fetch(`${HOST}/${RE_PATH}:streamQuery`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    class_method: 'stream_query',
    input: { user_id: 'test-sq-mia', message: 'What is the sick leave policy?' },
  }),
});
const sqt = await sqr.text();
console.log(`  stream_query: ${sqr.status}`);
if (sqr.ok) {
  const answer = sqt.split('\n').filter(Boolean)
    .map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
    .filter(Boolean)
    .flatMap(j => ((j!['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>> ?? []).map(p => p['text'] as string))
    .filter(Boolean).join('').slice(0, 400);
  console.log(`  ✅ Answer: ${answer}`);
} else {
  console.log(`  Error: ${sqt.slice(0, 300)}`);
}

// ── 3. Retry query (check if FAILED_PRECONDITION is transient) ────────────────
console.log('\n[3] Retrying class_method=query...');
for (let i = 0; i < 3; i++) {
  const qr = await fetch(`${HOST}/${RE_PATH}:streamQuery`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      class_method: 'query',
      input: { user_id: `q-retry-${i}`, message: 'What is the sick leave policy?' },
    }),
  });
  const qt = await qr.text();
  console.log(`  Attempt ${i + 1}: ${qr.status}`);
  if (qr.ok) {
    const answer = qt.split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } })
      .filter(Boolean)
      .flatMap(j => ((j!['content'] as Record<string, unknown>)?.['parts'] as Array<Record<string, unknown>> ?? []).map(p => p['text'] as string))
      .filter(Boolean).join('').slice(0, 300);
    console.log(`  ✅ QUERY WORKS! Answer: ${answer}`);
    break;
  } else {
    const errorDetails = (() => {
      try {
        const j = JSON.parse(qt) as Array<{ error: { message: string } }>;
        return j[0]?.error?.message ?? qt;
      } catch { return qt; }
    })();
    console.log(`  Error: ${errorDetails.slice(0, 400)}`);
    if (!errorDetails.includes('FAILED_PRECONDITION')) break; // different error, no point retrying
  }
  await new Promise(r => setTimeout(r, 2000));
}

// ── 4. Check logs again after query attempts ──────────────────────────────────
console.log('\n[4] Logs after query attempts...');
await new Promise(r => setTimeout(r, 3000));
const logR2 = await fetch(
  `https://logging.googleapis.com/v2/entries:list`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${miaToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      resourceNames: [`projects/${MIA_PROJECT_NUM}`],
      filter: [
        `resource.type="aiplatform.googleapis.com/ReasoningEngine"`,
        `resource.labels.reasoning_engine_id="${RE_ID}"`,
        `timestamp>="${new Date(Date.now() - 5 * 60 * 1000).toISOString()}"`,
      ].join('\n'),
      orderBy: 'timestamp desc',
      pageSize: 30,
    }),
  }
);
const logJ2 = await logR2.json() as { entries?: Array<{
  timestamp?: string; severity?: string;
  textPayload?: string; jsonPayload?: Record<string, unknown>;
}> };
console.log(`  Entries: ${logJ2.entries?.length ?? 0}`);
for (const e of logJ2.entries ?? []) {
  const ts = e.timestamp?.slice(11, 19) ?? '';
  const text = e.textPayload ?? JSON.stringify(e.jsonPayload ?? '');
  const isRelevant = ['query', 'stream_query', 'method', 'Error', 'InvocationMethod', 'POST', 'INFO'].some(k => text.includes(k));
  if (isRelevant) console.log(`  [${ts}] ${e.severity ?? ''}: ${text.slice(0, 200)}`);
}
