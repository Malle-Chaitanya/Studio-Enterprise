/**
 * Ask a deployed ADK Reasoning Engine directly, as a named person.
 *
 *   RE=1668809611580276736 Q="list your tools" npx tsx src/spikes/_probe_ask_re.ts
 *
 * `user_id` is the real end-user email — the same value Gemini Enterprise passes, and what
 * per-caller impersonation resolves on. Prints every tool the agent actually CALLED, which
 * is the capability evidence; prose alone can claim anything.
 *
 * NOT read-only by construction: the agent holds live write tools. Only send a question you
 * would be happy to have executed.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const P = process.env.PROJ || '505103737920';
const LOC = 'us-central1';
const RE = process.env.RE || '1668809611580276736';
const WHO = process.env.SUBJECT || 'admin@migrationn.com';
const Q = process.env.Q || 'List every tool you have, by exact name. Do not call any of them.';
const token = await getSaToken();
const url = `https://${LOC}-aiplatform.googleapis.com/v1beta1/projects/${P}/locations/${LOC}/reasoningEngines/${RE}:streamQuery?alt=sse`;
const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    class_method: process.env.METHOD || 'stream_query',
    input: { user_id: WHO, message: Q },
  }),
});
const t = await res.text();
if (!res.ok) { console.log(`HTTP ${res.status}\n${t.replace(/\s+/g, ' ').slice(0, 800)}`); process.exit(1); }

let out = '';
const calls: string[] = [];
const walk = (n: any): void => {
  if (Array.isArray(n)) return void n.forEach(walk);
  if (!n || typeof n !== 'object') return;
  if (n.function_call?.name) calls.push(String(n.function_call.name));
  if (n.functionCall?.name) calls.push(String(n.functionCall.name));
  if (typeof n.text === 'string') out += n.text;
  Object.values(n).forEach(walk);
};
for (const line of t.split('\n')) {
  const s = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
  if (!s) continue;
  try { walk(JSON.parse(s)); } catch { /* partial chunk */ }
}
console.log(`as: ${WHO}   RE=${RE}\nQ: ${Q}\n`);
console.log(out.trim().slice(0, 3500) || `(no text)\n\nraw:\n${t.slice(0, 900)}`);
if (calls.length) console.log(`\ntools CALLED: ${[...new Set(calls)].join(', ')}`);
process.exit(0);
