/**
 * Ask a deployed Gemini Enterprise agent ONE question, as a real person, through the same
 * streamAssist path the browser uses — so the answer is what a demo audience would see.
 *
 *   AGENT=3720927241338939125 Q="what can you do?" npx tsx src/spikes/_probe_ask_agent.ts
 *
 * READ-ONLY BY INTENT: it only sends the text you give it. A question that asks the agent to
 * send mail or write a record WILL cause that to happen — the agent has live write tools.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const P = process.env.PROJ || '505103737920';
const E = process.env.ENGINE || 'gemini-enterprise-app_1787446545912';
const AGENT = process.env.AGENT || '3720927241338939125';
const WHO = process.env.SUBJECT || 'admin@migrationn.com';
const Q = process.env.Q || 'What can you help me with? List every tool you have, by name.';
const token = await getSaToken(WHO);
const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/global/collections/default_collection/engines/${E}/assistants/default_assistant`;
const res = await fetch(`${base}:streamAssist`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  // agentsSpec.agentSpecs[].agentId — the BARE id. Passing a full resource name 400s, and
  // passing the older agentsConfig shape returns HTTP 200 from the DEFAULT assistant, which
  // reads exactly like the migrated agent having none of its tools. Confirmed 2026-09-13.
  body: JSON.stringify({ query: { text: Q }, agentsSpec: { agentSpecs: [{ agentId: AGENT }] } }),
});
const t = await res.text();
if (!res.ok) { console.log(`HTTP ${res.status}\n${t.replace(/\s+/g, ' ').slice(0, 600)}`); process.exit(1); }

// The stream is a JSON array of chunks; collect every assistant text part in order, and
// name every tool the agent actually invoked — the tool calls are the real capability
// evidence, the prose is just what it chose to say about them.
let out = '';
const tools: string[] = [];
const walk = (n: unknown): void => {
  if (Array.isArray(n)) return void n.forEach(walk);
  if (!n || typeof n !== 'object') return;
  const o = n as Record<string, any>;
  if (typeof o.text === 'string' && !o.toolCall) out += o.text;
  if (o.toolCall?.name) tools.push(String(o.toolCall.name));
  if (o.functionCall?.name) tools.push(String(o.functionCall.name));
  Object.values(o).forEach(walk);
};
try { walk(JSON.parse(t)); } catch { out = t.slice(0, 2000); }
console.log(`Q: ${Q}\nas: ${WHO}  agent=${AGENT}\n`);
console.log(out.trim().slice(0, 3000) || '(no text in response)');
if (tools.length) console.log(`\ntools invoked: ${[...new Set(tools)].join(', ')}`);
process.exit(0);
