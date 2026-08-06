import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const tok = await getSaToken();
const r = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: ['projects/studio-enterprise-migration'],
    filter: [
      'resource.type="aiplatform.googleapis.com/ReasoningEngine"',
      'resource.labels.reasoning_engine_id="6618586659455762432"',
      `timestamp>="${new Date(Date.now() - 10 * 60 * 1000).toISOString()}"`,
    ].join('\n'),
    orderBy: 'timestamp desc',
    pageSize: 50,
  }),
});
const j = await r.json() as { entries?: Array<Record<string, unknown>> };
console.log('total:', (j.entries ?? []).length);
for (const e of j.entries ?? []) {
  const pay = String(e['textPayload'] ?? JSON.stringify(e['jsonPayload'] ?? e['protoPayload'] ?? ''));
  const skip = ['startup complete', 'is starting up', 'server process', 'Waiting for application', 'telemetry enabled', 'LoggerProvider', 'httpx instrumentation', 'gRPC instrumentation', 'GenAI instrumentation'];
  if (skip.some(s => pay.includes(s))) continue;
  console.log(`[${String(e['timestamp']).slice(11, 19)}]: ${pay.slice(0, 600)}`);
}
