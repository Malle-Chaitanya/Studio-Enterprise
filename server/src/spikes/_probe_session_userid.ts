/** What user_id does Gemini Enterprise actually pass to a deployed ADK agent? */
import { getSaToken } from '../auth/google.js';
const P = 'studio-enterprise-migration';
const L = 'us-central1';
const t = await getSaToken();

const list = await fetch(
  `https://${L}-aiplatform.googleapis.com/v1beta1/projects/${P}/locations/${L}/reasoningEngines`,
  { headers: { Authorization: `Bearer ${t}` } });
const j = await list.json() as { reasoningEngines?: Array<{ name: string; displayName?: string }> };
const engines = j.reasoningEngines ?? [];
console.log('engines:', engines.length);

let shown = 0;
for (const e of engines) {
  let s: Response;
  try {
    s = await fetch(`https://${L}-aiplatform.googleapis.com/v1beta1/${e.name}/sessions`,
      { headers: { Authorization: `Bearer ${t}` } });
  } catch { continue; }   // transient TLS reset across 82 engines — skip, keep going
  if (!s.ok) continue;
  const sj = await s.json() as { sessions?: Array<{ name: string; userId?: string; createTime?: string }> };
  const sess = sj.sessions ?? [];
  if (!sess.length) continue;
  console.log(`\n${e.displayName ?? e.name.split('/').pop()} — ${sess.length} session(s)`);
  for (const x of sess.slice(0, 5)) console.log('   userId:', JSON.stringify(x.userId), '| created:', x.createTime);
  if (++shown >= 6) break;
}
