/** Reasoning Engine errors only. Read-only. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const ENGINE = process.argv[2] ?? '5559598632233074688';
const PROJECT = process.argv[3] ?? '231705905417';
const token = await getSaToken();
const filter = `resource.labels.reasoning_engine_id="${ENGINE}" AND timestamp>="${new Date(Date.now() - 90 * 60 * 1000).toISOString()}" AND (severity>=WARNING OR textPayload:("Error" OR "error" OR "HTTP" OR "Traceback" OR "401" OR "403" OR "404"))`;
const res = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ resourceNames: [`projects/${PROJECT}`], filter, orderBy: 'timestamp desc', pageSize: 60 }),
});
if (!res.ok) { console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`); process.exit(0); }
const entries = ((await res.json()) as any).entries ?? [];
console.log(`error-ish entries: ${entries.length}`);
for (const e of entries.reverse()) {
  const msg = e.textPayload ?? JSON.stringify(e.jsonPayload ?? {});
  console.log(`[${e.timestamp}] ${e.severity ?? ''} ${String(msg).slice(0, 600)}`);
}
process.exit(0);
