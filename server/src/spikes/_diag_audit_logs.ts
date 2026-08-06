/**
 * Check audit logs for RE invocation attempts (who called, what failed).
 * Usage: cd server && npx tsx src/spikes/_diag_audit_logs.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SA_PROJECT  = 'studio-enterprise-migration';
const SA_PROJ_NUM = '231705905417';
const RE_ID       = '6740183849394765824';
const tok = await getSaToken();

// ── Audit logs: who called the RE ─────────────────────────────────────────────
console.log('=== Audit logs for RE streamQuery calls ===');
const t1h = new Date(Date.now() - 60 * 60 * 1000);
const auditRes = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${SA_PROJECT}`],
    filter: [
      `protoPayload.serviceName="aiplatform.googleapis.com"`,
      `timestamp>="${t1h.toISOString()}"`,
    ].join('\n'),
    orderBy: 'timestamp desc',
    pageSize: 20,
  }),
});
const auditJson = await auditRes.json() as { entries?: Array<Record<string, unknown>> };
const auditEntries = auditJson.entries ?? [];
console.log(`${auditRes.status} — ${auditEntries.length} audit log entries`);
for (const e of auditEntries) {
  const proto = e['protoPayload'] as Record<string, unknown> | undefined;
  const method = proto?.['methodName'];
  const caller = (proto?.['authenticationInfo'] as Record<string, unknown>)?.['principalEmail'];
  const status = proto?.['status'];
  const ts = String(e['timestamp']).slice(11, 19);
  console.log(`[${ts}] ${method} | caller: ${caller} | status: ${JSON.stringify(status)}`);
}

// ── Also try: all logs (not just aiplatform) for RE resource ──────────────────
console.log('\n=== All logs for RE resource (last 30min, any severity) ===');
const t30 = new Date(Date.now() - 30 * 60 * 1000);
const allLogsRes = await fetch('https://logging.googleapis.com/v2/entries:list', {
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
const allLogsJson = await allLogsRes.json() as { entries?: Array<Record<string, unknown>> };
const allEntries = allLogsJson.entries ?? [];
console.log(`${allLogsRes.status} — ${allEntries.length} entries`);
for (const e of allEntries) {
  const sev = e['severity'] ?? '?';
  const ts  = String(e['timestamp']).slice(11, 19);
  const pay = e['textPayload'] ?? e['jsonPayload'] ?? e['protoPayload'];
  const text = JSON.stringify(pay);
  // Skip startup spam
  if (text.includes('Application startup') || text.includes('server process') || text.includes('Waiting for')) continue;
  console.log(`[${sev}] ${ts}: ${text.slice(0, 500)}`);
}
console.log('(startup messages filtered)');
