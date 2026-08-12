/**
 * Ask the migrated "Hubspot agentt" a question only a REAL HubSpot call can answer.
 *
 * `deployed=true` is not `works=true`. The run reports four operations rebuilt as exact
 * API calls, but that is a statement about what we BUILT, not about what happens when a
 * user asks. The only evidence that settles it is the deployed agent returning data that
 * exists in HubSpot and nowhere in a model's training set.
 *
 * A refusal or an error is a RESULT, not a failure of this probe — print it verbatim
 * rather than retrying until something looks like success.
 *
 * npx tsx src/spikes/_probe_hubspot_live_answer.ts <reasoningEngineId> ["question"]
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const ENGINE = process.argv[2];
const QUESTION =
  process.argv[3] ??
  'List the HubSpot companies you can see. Give me their names exactly as they appear in the CRM. ' +
  'If a tool call fails, tell me the exact error instead of guessing.';
if (!ENGINE) {
  console.error('usage: _probe_hubspot_live_answer.ts <reasoningEngineId> ["question"]');
  process.exit(1);
}

const PROJECT = process.env.ADK_PROJECT || '231705905417';
const LOCATION = process.env.ADK_LOCATION || 'us-central1';
const BASE = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1`;
const NAME = `projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${ENGINE}`;

const token = await getSaToken();
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

// A session is required before streamQuery; the user id is arbitrary but must be stable.
const userId = 'probe-hubspot';
const sess = await fetch(`${BASE}/${NAME}:query`, {
  method: 'POST',
  headers,
  body: JSON.stringify({ class_method: 'async_create_session', input: { user_id: userId } }),
});
const sessBody = await sess.text();
console.log(`create_session → HTTP ${sess.status}`);
if (!sess.ok) {
  console.log(sessBody.slice(0, 600));
  process.exit(1);
}
const sessionId = (JSON.parse(sessBody) as { output?: { id?: string } }).output?.id;
console.log(`session: ${sessionId}\n`);

console.log(`question: ${QUESTION}\n`);
const res = await fetch(`${BASE}/${NAME}:streamQuery?alt=sse`, {
  method: 'POST',
  headers,
  body: JSON.stringify({
    class_method: 'async_stream_query',
    input: { user_id: userId, session_id: sessionId, message: QUESTION },
  }),
});
console.log(`streamQuery → HTTP ${res.status}\n`);
const body = await res.text();
if (!res.ok) {
  console.log(body.slice(0, 1200));
  process.exit(1);
}

// Print what the agent DID (tool calls and their responses) alongside what it said, so a
// fluent answer with no tool call cannot be mistaken for a working integration.
for (const line of body.split('\n')) {
  const t = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
  if (!t) continue;
  try {
    const evt = JSON.parse(t) as {
      content?: { parts?: Array<{ text?: string; functionCall?: { name?: string; args?: unknown }; functionResponse?: { name?: string; response?: unknown } }> };
    };
    for (const p of evt.content?.parts ?? []) {
      if (p.functionCall) {
        console.log(`  → TOOL CALL  ${p.functionCall.name}  args=${JSON.stringify(p.functionCall.args).slice(0, 200)}`);
      }
      if (p.functionResponse) {
        console.log(`  ← TOOL REPLY ${p.functionResponse.name}: ${JSON.stringify(p.functionResponse.response).slice(0, 700)}`);
      }
      if (p.text) console.log(`\nANSWER: ${p.text.trim()}`);
    }
  } catch {
    // Not every SSE line is a JSON event; skip quietly rather than pretend it failed.
  }
}
process.exit(0);
