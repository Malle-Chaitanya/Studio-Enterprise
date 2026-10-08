/** Every agent on the destination engine, newest first, with its reasoning-engine id.
 *  Read-only. Used to pick the right "Deal Desk" / "Workmate" before demoing. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const P = process.env.PROJ || '505103737920';
const E = process.env.ENGINE || 'gemini-enterprise-app_1787446545912';
// SUBJECT='' means mint as the service account ITSELF. Impersonating a Workspace user from
// one customer's domain is 403 on another org's project, which reads like a missing agent.
const SUB = process.env.SUBJECT === undefined ? 'admin@migrationn.com' : process.env.SUBJECT;
const token = await getSaToken(SUB || undefined);
const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/global/collections/default_collection/engines/${E}/assistants/default_assistant`;
const r = await fetch(`${base}/agents?pageSize=100`, { headers: { Authorization: `Bearer ${token}` } });
const t = await r.text();
if (!r.ok) { console.log(`HTTP ${r.status} ${t.replace(/\s+/g,' ').slice(0,300)}`); process.exit(1); }
const agents = ((JSON.parse(t) as { agents?: any[] }).agents ?? []);
console.log(`${agents.length} agent(s)\n`);
for (const a of agents) {
  const re = a.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine ?? '';
  console.log(`${(a.displayName ?? '').padEnd(22)} agent=${String(a.name).split('/').pop()}  re=${re.split('/').pop() || '(none)'}  state=${a.state ?? ''}`);
}
process.exit(0);
