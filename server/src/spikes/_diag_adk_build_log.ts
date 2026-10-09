/** The Reasoning Engine build log. Vertex returns a generic "400 Build failed"; the real
 *  pip/compile error lands in Cloud Logging for the project. Read-only. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = process.env.CSGE_PROJECT ?? 'agentmigrations';
const MINUTES = Number(process.env.CSGE_MINUTES ?? 180);
const token = await getSaToken();
const since = new Date(Date.now() - MINUTES * 60_000).toISOString();

const filter = [
  `timestamp >= "${since}"`,
  '(logName:"cloudbuild" OR resource.type="build" OR resource.type="aiplatform.googleapis.com/ReasoningEngine")',
].join(' AND ');

const res = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${PROJECT}`],
    filter,
    orderBy: 'timestamp desc',
    pageSize: 300,
  }),
});
const body = await res.text();
if (!res.ok) { console.log(`entries:list -> ${res.status}: ${body.slice(0, 500)}`); process.exit(0); }
const j = JSON.parse(body) as { entries?: { timestamp: string; textPayload?: string; jsonPayload?: Record<string, unknown>; severity?: string }[] };
const entries = (j.entries ?? []).reverse();
console.log(`${entries.length} entries in the last ${MINUTES} min`);
const ALL = process.env.CSGE_ALL === '1';
const hits = ALL ? [] : entries.filter((e) => {
  const t = e.textPayload ?? JSON.stringify(e.jsonPayload ?? {});
  return /error|ERROR|Traceback|No matching distribution|conflict|cannot|failed|Exception|not found/i.test(t);
});
for (const e of (hits.length ? hits : entries).slice(-45)) {
  const t = (e.textPayload ?? JSON.stringify(e.jsonPayload ?? {})).replace(/\s+$/, '');
  console.log(`${e.timestamp.slice(11, 19)} ${(e.severity ?? '').padEnd(7)} ${t.slice(0, 900)}`);
}
process.exit(0);
