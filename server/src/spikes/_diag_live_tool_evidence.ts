/**
 * Read-only evidence that the live connector tool really executes an authenticated
 * HTTP call to Confluence. Creates nothing, changes nothing, deploys nothing.
 *
 * The ADK event stream carries the agent's tool traffic verbatim:
 *   - functionCall     — the model invoking confluence_live_search(query=...)
 *   - functionResponse — what the tool RETURNED from inside the container
 *
 * A functionResponse containing real page titles, space names and resolvable URLs can
 * only come from a live Confluence API response: the model cannot fabricate a
 * functionResponse (it is the runtime's record of the tool's own return value), and
 * the tool's only way to produce one is the HTTP call it makes after reading the
 * credential from Secret Manager. If the credential were missing or wrong, the same
 * event would carry {"error": "credential lookup failed"} or an HTTP 401 instead.
 *
 * npx tsx src/spikes/_diag_live_tool_evidence.ts [reasoningEngineId] ["question"]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const RE_ID = process.argv[2] ?? '2859796208740728832';
const QUESTION = process.argv[3] ?? 'How many days of earned leave do I get?';
const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const USER_ID = 'cf-evidence';

const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
const re = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${RE_ID}`;

const cs = await fetch(`${re}:query`, {
  method: 'POST', headers: h,
  body: JSON.stringify({ class_method: 'create_session', input: { user_id: USER_ID } }),
});
const sessionId = /"id":\s*"([^"]+)"/.exec(await cs.text())?.[1];

const r = await fetch(`${re}:streamQuery?alt=sse`, {
  method: 'POST', headers: h,
  body: JSON.stringify({ class_method: 'stream_query', input: { user_id: USER_ID, session_id: sessionId, message: QUESTION } }),
});
const stream = await r.text();

console.log(`engine=${RE_ID}  status=${r.status}  bytes=${stream.length}`);
console.log(`question: ${QUESTION}\n`);

// ── Which tools did the model actually invoke? ────────────────────────────────
const calls = [...stream.matchAll(/"functionCall":\s*\{[^}]*"name":\s*"([^"]+)"/g)].map((m) => m[1]);
const altCalls = [...stream.matchAll(/"function_call":\s*\{[^}]*"name":\s*"([^"]+)"/g)].map((m) => m[1]);
const toolNames = [...new Set([...calls, ...altCalls])];
console.log(`── tool calls in the stream: ${toolNames.length ? toolNames.join(', ') : '(none found)'}`);

// The query the model passed to the live tool.
const queryArg = /"confluence_live_search"[\s\S]{0,300}?"query":\s*"((?:[^"\\]|\\.)*)"/.exec(stream)?.[1];
if (queryArg) console.log(`── query the model sent to Confluence: "${queryArg}"`);

// ── What did the tool return? (the runtime's record, not model text) ──────────
const respIdx = stream.search(/"functionResponse"|"function_response"/);
if (respIdx >= 0) {
  console.log(`\n── functionResponse payload (raw, truncated) ──`);
  console.log(stream.slice(respIdx, respIdx + 1600));
} else {
  console.log('\n── no functionResponse found — the tool did not return to the model');
}

// ── Hard signals inside the tool's return value ──────────────────────────────
const urls = [...new Set([...stream.matchAll(/https:\/\/[a-z0-9.-]+atlassian\.net\/wiki[^"\\\s]*/gi)].map((m) => m[0]))];
const credFailure = /credential lookup failed|401|Unauthorized/i.test(stream);
console.log(`\n── evidence ──`);
console.log(`  confluence URLs returned : ${urls.length}`);
for (const u of urls.slice(0, 6)) console.log(`    ${u}`);
console.log(`  credential/auth failure  : ${credFailure ? 'YES' : 'no'}`);
console.log(`  verdict: ${
  toolNames.includes('confluence_live_search') && urls.length > 0 && !credFailure
    ? 'REAL — live tool invoked, returned live Confluence URLs, credential resolved OK'
    : 'INCONCLUSIVE — see raw payload above'
}`);
