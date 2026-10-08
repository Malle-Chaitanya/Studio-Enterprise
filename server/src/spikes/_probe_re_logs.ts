/** Recent Reasoning Engine log entries for the deployed Deal Desk 3 container. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const PROJECT = '505103737920';
const RE_ID = process.env.RE_ID || '4850250904596643840';
const token = await getSaToken();
const body = {
  resourceNames: [`projects/${PROJECT}`],
  filter: `resource.type="aiplatform.googleapis.com/ReasoningEngine" AND resource.labels.reasoning_engine_id="${RE_ID}" AND timestamp>="${new Date(Date.now() - 60 * 60 * 1000).toISOString()}"`,
  orderBy: 'timestamp desc',
  pageSize: 200,
};
const r = await fetch('https://logging.googleapis.com/v2/entries:list', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
const j = (await r.json()) as any;
if (j.error) { console.log('ERR ' + JSON.stringify(j.error).slice(0, 300)); process.exit(0); }
for (const e of (j.entries ?? []).reverse()) {
  const msg = e.textPayload ?? JSON.stringify(e.jsonPayload ?? {});
  const t = String(msg);
  if (!/error|Error|refus|denied|Traceback|could not|cannot|fail|403|401|400/i.test(t)) continue;
  console.log(`${String(e.timestamp).slice(11, 19)} ${t.slice(0, 420)}`);
}
console.log(`(${(j.entries ?? []).length} entries)`);
process.exit(0);
