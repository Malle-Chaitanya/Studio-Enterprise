/**
 * Invoke a google-adk Reasoning Engine the way it actually wants to be invoked.
 *
 * The 400s were not a platform bug: ADK-framework engines expose NO `query` method
 * (only stream_query / async_stream_query / streaming_agent_run_with_events plus
 * session management). The correct sequence is:
 *   1. :query   class_method=create_session   -> session id
 *   2. :streamQuery class_method=stream_query  -> streamed events
 *
 * npx tsx src/spikes/_probe_re_stream_query.ts <reasoningEngineId> [question]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const RE_ID = process.argv[2];
const QUESTION = process.argv[3] ?? 'What is the sick leave policy?';
const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const USER_ID = 'cf-probe-user';
const HOST = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1`;

if (!RE_ID) { console.error('usage: _probe_re_stream_query.ts <reasoningEngineId> [question]'); process.exit(1); }

const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
const re = `${HOST}/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${RE_ID}`;

// ── 0. what does this engine expose? ──────────────────────────────────────────
const gr = await fetch(re, { headers: h });
const gj = await gr.json() as { displayName?: string; spec?: { agentFramework?: string; classMethods?: Array<{ name?: string }> } };
const methods = (gj.spec?.classMethods ?? []).map((m) => m.name ?? '?');
console.log(`engine    : ${RE_ID}  "${gj.displayName ?? ''}"`);
console.log(`framework : ${gj.spec?.agentFramework ?? '(unset)'}`);
console.log(`methods   : ${methods.join(', ')}\n`);

// ── 1. create_session ─────────────────────────────────────────────────────────
let sessionId = '';
if (methods.includes('create_session')) {
  const r = await fetch(`${re}:query`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ class_method: 'create_session', input: { user_id: USER_ID } }),
  });
  const t = await r.text();
  console.log(`[${r.status}] create_session`);
  console.log(`  ${t.replace(/\s+/g, ' ').slice(0, 320)}`);
  if (r.ok) {
    const m = /"id":\s*"([^"]+)"/.exec(t);
    sessionId = m?.[1] ?? '';
  }
} else {
  console.log('(no create_session — engine is not ADK-framework)');
}

// ── 2. stream_query ───────────────────────────────────────────────────────────
const bodies: Array<[string, unknown]> = sessionId
  ? [['stream_query + session', { class_method: 'stream_query', input: { user_id: USER_ID, session_id: sessionId, message: QUESTION } }]]
  : [];
// engines without sessions (custom framework) take plain input
bodies.push(['stream_query no session', { class_method: 'stream_query', input: { message: QUESTION } }]);
if (methods.includes('query')) bodies.push(['query (custom only)', { class_method: 'query', input: { message: QUESTION } }]);

for (const [label, body] of bodies) {
  const url = String(label).startsWith('query') ? `${re}:query` : `${re}:streamQuery?alt=sse`;
  const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const t = await r.text();
  console.log(`\n[${r.status}] ${label}`);
  if (!r.ok) { console.log(`  ${t.replace(/\s+/g, ' ').slice(0, 400)}`); continue; }
  // pull out the model's text parts from the streamed events
  const texts = [...t.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => {
    try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]; }
  });
  console.log(`  events bytes=${t.length}  text parts=${texts.length}`);
  console.log(`  ANSWER: ${texts.join('').replace(/\s+/g, ' ').slice(0, 600) || '(no text — raw: ' + t.replace(/\s+/g, ' ').slice(0, 300) + ')'}`);
}
