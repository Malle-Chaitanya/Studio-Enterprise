/**
 * Check v8 RE logs to see what class_method Agentspace used.
 *
 * Run AFTER testing "Confluence Knowledge Agent v8-reg" in business.gemini.google:
 *   cd server && npx tsx src/spikes/_check_re_logs.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT = 'studio-enterprise-migration';
const V8_RE_ID = '8175706230619111424';

const token = await getSaToken();
const since = new Date(Date.now() - 60 * 60 * 1000).toISOString(); // last 1 hour

console.log(`Checking RE ${V8_RE_ID} logs (last 1 hour)...`);
const r = await fetch('https://logging.googleapis.com/v2/entries:list', {
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
    pageSize: 60,
  }),
});

const j = await r.json() as { entries?: Array<Record<string, unknown>> };
const entries = j.entries ?? [];
console.log(`Found ${entries.length} log entries\n`);

const skipPatterns = ['startup', 'server process', 'telemetry', 'LoggerProvider', 'GenAI', 'TraceProvider', 'instrumentation', 'FutureWarning'];

for (const e of entries) {
  const pay = String(e['textPayload'] ?? JSON.stringify(e['jsonPayload'] ?? e['protoPayload'] ?? ''));
  if (skipPatterns.some(s => pay.includes(s))) continue;
  const ts = String(e['timestamp']).slice(11, 19);
  console.log(`[${ts}] ${pay.slice(0, 600)}`);
}

// Summarize what we found
const allText = entries.map(e => String(e['textPayload'] ?? '')).join('\n');
console.log('\n══════════ SUMMARY ══════════');
if (allText.includes("method `query`")) {
  console.log('❌ Agentspace sent class_method=query — not supported by RE');
  console.log('   This confirms the platform limitation. "Something went wrong" expected.');
} else if (allText.includes('stream_query') && allText.includes('POST /api/stream_reasoning_engine')) {
  console.log('✅ Agentspace sent class_method=stream_query — agent should work!');
  console.log('   ADK path is viable for Confluence-grounded agents.');
} else if (entries.length === 0) {
  console.log('⚠️ No logs found — agent not tested yet, or RE container went cold.');
  console.log('   Open business.gemini.google, find "Confluence Knowledge Agent v8-reg", ask a question, then re-run this script.');
} else {
  console.log('⚠️ Could not determine class_method from logs. Raw entries above.');
}
