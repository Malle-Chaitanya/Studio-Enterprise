/** Read the deployed Reasoning Engine's own logs. Read-only, no secret values. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const ENGINE = process.argv[2] ?? '5559598632233074688';
const PROJECT = process.argv[3] ?? '231705905417';
const token = await getSaToken();
const res = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${PROJECT}`],
    filter: `resource.labels.reasoning_engine_id="${ENGINE}" AND timestamp>="${new Date(Date.now() - 60 * 60 * 1000).toISOString()}"`,
    orderBy: 'timestamp desc',
    pageSize: 60,
  }),
});
if (!res.ok) { console.log(`HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`); process.exit(0); }
const body = (await res.json()) as { entries?: any[] };
const entries = body.entries ?? [];
console.log(`entries: ${entries.length}`);
for (const e of entries.reverse()) {
  const msg = e.textPayload ?? JSON.stringify(e.jsonPayload ?? {}).slice(0, 500);
  console.log(`[${e.timestamp}] ${e.severity ?? ''} ${String(msg).slice(0, 500)}`);
}
process.exit(0);
