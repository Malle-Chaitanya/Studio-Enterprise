/**
 * Drive a DEPLOYED agent directly, the way _diag_live_tool_evidence.ts does in our own
 * project — create a session, ask one question, and report which tools the model actually
 * invoked. The tool calls are the capability evidence; the prose is only what it says.
 *
 *   RE=1668809611580276736 Q="..." npx tsx src/spikes/_probe_re_direct.ts
 *
 * NOT read-only by construction: these agents hold live write tools (send mail, Dataverse
 * writes, flows). Only send a question you are willing to have executed for real.
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = process.env.PROJ || '505103737920';
const LOC = 'us-central1';
const RE_ID = process.env.RE || '1668809611580276736';
const USER = process.env.SUBJECT || 'admin@migrationn.com';
const Q = process.env.Q || 'Hello - what can you help me with?';

const token = await getSaToken();
const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const re = `https://${LOC}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOC}/reasoningEngines/${RE_ID}`;

const cs = await fetch(`${re}:query`, {
  method: 'POST',
  headers: h,
  body: JSON.stringify({ class_method: 'create_session', input: { user_id: USER } }),
});
const ct = await cs.text();
console.log(`create_session -> HTTP ${cs.status}${cs.ok ? '' : '  ' + ct.replace(/\s+/g, ' ').slice(0, 260)}`);
if (!cs.ok) process.exit(1);
const sessionId = /"id":\s*"([^"]+)"/.exec(ct)?.[1];
console.log(`session=${sessionId}`);

// Read the SSE frames incrementally. A tool that calls a slow API (calendar, Graph) keeps
// the stream open for minutes, and res.text() was aborting as ECONNRESET partway — which
// looks exactly like the agent refusing.
async function ask(): Promise<{ status: number; body: string }> {
  const r0 = await fetch(`${re}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({
      class_method: 'stream_query',
      input: { user_id: USER, session_id: sessionId, message: Q },
    }),
    signal: AbortSignal.timeout(Number(process.env.TIMEOUT_MS || 480000)),
  });
  let body = '';
  const reader = r0.body?.getReader();
  const dec = new TextDecoder();
  if (reader) for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    body += dec.decode(value, { stream: true });
  }
  return { status: r0.status, body };
}
let got = { status: 0, body: '' };
for (let attempt = 1; attempt <= 2; attempt++) {
  try { got = await ask(); break; }
  catch (e) { console.log(`attempt ${attempt} failed: ${(e as Error).message}`); }
}
const r = { status: got.status };
const stream = got.body;
console.log(`stream_query   -> HTTP ${r.status}  bytes=${stream.length}`);
console.log(`as: ${USER}\nQ: ${Q}\n`);

// The name is not always the first key inside the object, so do not stop at the first brace.
const callRe = /"(?:functionCall|function_call)":\s*\{[\s\S]{0,400}?"name":\s*"([^"]+)"/g;
const tools = [...new Set([...stream.matchAll(callRe)].map((m) => m[1]))];

// Reassemble the assistant prose out of the SSE frames. Each "text" value is a JSON string
// literal, so parse it as one rather than hand-unescaping newlines.
const textRe = /"text":\s*"((?:[^"\\]|\\.)*)"/g;
let text = '';
for (const m of stream.matchAll(textRe)) {
  try {
    text += JSON.parse(`"${m[1]}"`) as string;
  } catch {
    text += m[1];
  }
}

console.log(text.trim().slice(0, 3000) || stream.slice(0, 800));
console.log(`\ntools called: ${tools.join(', ') || '(none)'}`);
process.exit(0);
