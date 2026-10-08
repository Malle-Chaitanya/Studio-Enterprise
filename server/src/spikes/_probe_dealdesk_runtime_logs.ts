/** Newest Reasoning Engine in the DESTINATION project + its recent errors. The container's
 *  own log is the only place a runtime auth failure states its real cause; the agent's chat
 *  reply ("authentication error") is the model paraphrasing a tool error it cannot see into. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = process.env.PROJECT || 'agentmigrations';
const LOC = process.env.LOC || 'us-central1';
const MINS = Number(process.env.MINS || 120);
const token = await getSaToken();

const lr = await fetch(
  `https://${LOC}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOC}/reasoningEngines`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const lt = await lr.text();
if (!lr.ok) { console.log(`list REs: HTTP ${lr.status} ${lt.replace(/\s+/g,' ').slice(0,300)}`); process.exit(1); }
const engines = ((JSON.parse(lt) as { reasoningEngines?: { name: string; displayName?: string; updateTime?: string }[] }).reasoningEngines ?? [])
  .sort((a, b) => String(b.updateTime).localeCompare(String(a.updateTime)));
console.log(`reasoning engines in ${PROJECT} (newest first):`);
engines.slice(0, 6).forEach((e) => console.log(`  ${e.name.split('/').pop()}  ${e.displayName ?? ''}  ${e.updateTime ?? ''}`));
const RE_ID = process.env.RE_ID || engines[0]?.name.split('/').pop();
if (!RE_ID) process.exit(0);
console.log(`\n--- errors from ${RE_ID}, last ${MINS}m ---`);

const r = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    resourceNames: [`projects/${PROJECT}`],
    filter: `resource.type="aiplatform.googleapis.com/ReasoningEngine" AND resource.labels.reasoning_engine_id="${RE_ID}" AND timestamp>="${new Date(Date.now() - MINS * 60 * 1000).toISOString()}"`,
    orderBy: 'timestamp desc',
    pageSize: 300,
  }),
});
const j = (await r.json()) as { error?: unknown; entries?: { timestamp?: string; textPayload?: string; jsonPayload?: unknown }[] };
if (j.error) { console.log('ERR ' + JSON.stringify(j.error).slice(0, 300)); process.exit(0); }
let n = 0;
for (const e of (j.entries ?? []).reverse()) {
  const t = String(e.textPayload ?? JSON.stringify(e.jsonPayload ?? {}));
  if (!/error|refus|denied|Traceback|could not|cannot|unauthor|invalid|fail|40[0-9]|50[0-9]/i.test(t)) continue;
  console.log(`${String(e.timestamp).slice(11, 19)} ${t.replace(/\s+/g, ' ').slice(0, 400)}`);
  n++;
}
console.log(n ? `\n${n} matching line(s)` : '\nno error lines in window');
process.exit(0);
