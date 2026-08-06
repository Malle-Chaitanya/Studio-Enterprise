import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT = 'studio-enterprise-migration';
const RE_ID = '6618586659455762432';
const tok = await getSaToken();

const t30 = new Date(Date.now() - 30 * 60 * 1000);
const r = await fetch('https://logging.googleapis.com/v2/entries:list', {
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
    pageSize: 50,
  }),
});
const j = await r.json() as { entries?: Array<Record<string, unknown>> };
const entries = j.entries ?? [];
console.log(`${entries.length} log entries for RE ${RE_ID}`);
for (const e of entries) {
  const pay = String(e['textPayload'] ?? JSON.stringify(e['jsonPayload'] ?? e['protoPayload'] ?? ''));
  if (pay.includes('startup') || pay.includes('Application') || pay.includes('server process') || pay.includes('Waiting')) continue;
  console.log(`[${String(e['timestamp']).slice(11, 19)}]: ${pay.slice(0, 600)}`);
}

// Also check audit logs for streamQuery calls
console.log('\n--- audit logs ---');
const a = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${SA_PROJECT}`],
    filter: `protoPayload.serviceName="aiplatform.googleapis.com"\ntimestamp>="${t30.toISOString()}"`,
    orderBy: 'timestamp desc',
    pageSize: 10,
  }),
});
const aj = await a.json() as { entries?: Array<Record<string, unknown>> };
for (const e of aj.entries ?? []) {
  const proto = e['protoPayload'] as Record<string, unknown>;
  const method = proto?.['methodName'];
  const caller = (proto?.['authenticationInfo'] as Record<string, unknown>)?.['principalEmail'];
  const status = proto?.['status'];
  if (String(method).includes('stream') || String(method).includes('query') || String(method).includes('Query')) {
    console.log(`[${String(e['timestamp']).slice(11, 19)}] ${method} | caller: ${caller} | status: ${JSON.stringify(status)}`);
  }
}
