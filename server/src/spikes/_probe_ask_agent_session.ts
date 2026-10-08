/** Same as _probe_ask_agent but with a REAL session created first — the UI always has one,
 *  and agent routing may depend on it. Read-only question only. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const P = '505103737920', E = 'gemini-enterprise-app_1787446545912';
const AGENT = process.env.AGENT || '3720927241338939125';
const WHO = process.env.SUBJECT || 'admin@migrationn.com';
const Q = process.env.Q || 'Which tools do you have? Name them exactly. Do not call any.';
const token = await getSaToken(WHO);
const eng = `https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/global/collections/default_collection/engines/${E}`;
const base = `${eng}/assistants/default_assistant`;

const sr = await fetch(`${eng}/sessions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ userPseudoId: WHO, displayName: 'capability probe' }),
});
const st = await sr.text();
console.log(`create session -> HTTP ${sr.status}`);
if (!sr.ok) { console.log(st.replace(/\s+/g, ' ').slice(0, 300)); process.exit(1); }
const session = (JSON.parse(st) as { name: string }).name;
console.log(`session=${session.split('/').pop()}`);

// Read the stream in chunks rather than res.text(). An ADK agent takes tens of seconds to
// answer (it calls real APIs), and the one-shot read was aborting mid-stream as ECONNRESET —
// which looks identical to the server refusing, and sent me hunting a billing problem.
async function ask(): Promise<{ status: number; body: string }> {
  const res = await fetch(`${base}:streamAssist`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      query: { text: Q },
      session,
      agentsSpec: { agentSpecs: [{ agentId: AGENT }] },
      userMetadata: { preferredLanguageCode: 'en' },
    }),
    signal: AbortSignal.timeout(Number(process.env.TIMEOUT_MS || 300000)),
  });
  let body = '';
  const reader = res.body?.getReader();
  const dec = new TextDecoder();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      body += dec.decode(value, { stream: true });
    }
  }
  return { status: res.status, body };
}
let res = { status: 0, body: '' };
for (let attempt = 1; attempt <= 3; attempt++) {
  try { res = await ask(); break; }
  catch (e) { console.log(`attempt ${attempt}: ${(e as Error).message}`); if (attempt === 3) process.exit(1); }
}
const t = res.body;
let out = '';
const calls: string[] = [];
const walk = (n: any): void => {
  if (Array.isArray(n)) return void n.forEach(walk);
  if (!n || typeof n !== 'object') return;
  if (typeof n.text === 'string') out += n.text;
  if (n.agentId) calls.push(`agentId=${n.agentId}`);
  Object.values(n).forEach(walk);
};
try { walk(JSON.parse(t)); } catch { out = t.slice(0, 1500); }
console.log(`\nHTTP ${res.status}  ${/Gemini Enterprise✨|selfawareness_agent/.test(out) ? '<< DEFAULT ASSISTANT' : '<< agent'}`);
console.log(out.trim().slice(0, 2500));
if (calls.length) console.log(`\nmarkers: ${[...new Set(calls)].join(', ')}`);
process.exit(0);
