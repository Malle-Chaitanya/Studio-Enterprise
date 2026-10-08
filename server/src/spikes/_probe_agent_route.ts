/** WHICH streamAssist body actually routes to a named agent instead of the default assistant.
 *  Answered before (see _diag_streamassist.ts) but for a different engine/agent — re-proving
 *  it here because a wrong body silently answers AS Gemini Enterprise, which looks like the
 *  migrated agent having no tools. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const P = '505103737920', E = 'gemini-enterprise-app_1787446545912';
const AGENT = process.env.AGENT || '3720927241338939125';
const token = await getSaToken('admin@migrationn.com');
const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/global/collections/default_collection/engines/${E}/assistants/default_assistant`;
const agentRes = `${base}/agents/${AGENT}`;
const q = 'Which Dataverse or Gmail tools do you have? Name them exactly.';
const cases: [string, unknown][] = [
  ['agentsConfig.agent', { query: { text: q }, agentsConfig: { agent: agentRes } }],
  ['agentsSpec', { query: { text: q }, agentsSpec: { agentSpecs: [{ agent: agentRes }] } }],
  ['agent+REQUEST_ASSIST', { query: { text: q }, assistSkippingMode: 'REQUEST_ASSIST', agentsConfig: { agent: agentRes } }],
  ['session+agent', { query: { text: q }, agentsConfig: { agent: agentRes }, session: `${base}/sessions/-` }],
];
for (const [label, body] of cases) {
  let res: Response; let t: string;
  try {
    res = await fetch(`${base}:streamAssist`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    t = await res.text();
  } catch (e) {
    // A body shape the server rejects mid-stream shows up as ECONNRESET, not a status code.
    console.log(`
### ${label} -> CONNECTION RESET (${(e as Error).message})`);
    continue;
  }
  let txt = '';
  const walk = (n: any): void => {
    if (Array.isArray(n)) return void n.forEach(walk);
    if (!n || typeof n !== 'object') return;
    if (typeof n.text === 'string') txt += n.text;
    Object.values(n).forEach(walk);
  };
  try { walk(JSON.parse(t)); } catch { txt = t; }
  const looksDefault = /Gemini Enterprise|selfawareness_agent|imagen_agent/i.test(txt);
  console.log(`\n### ${label} -> HTTP ${res.status}  ${looksDefault ? 'DEFAULT ASSISTANT (routing failed)' : 'agent answered'}`);
  console.log('    ' + txt.replace(/\s+/g, ' ').slice(0, 260));
}
process.exit(0);
