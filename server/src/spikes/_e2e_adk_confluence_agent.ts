/**
 * ADK end-to-end: deploy a Reasoning Engine grounded on the Confluence data store,
 * register it into the Gemini Enterprise engine, then invoke it over the API.
 *
 * Why ADK instead of the low-code path:
 *   - registerAdkAgent returns state=ENABLED, so no console Publish click
 *   - VertexAiSearchTool bakes the data store resource path into the deployment,
 *     so it needs no engine.dataStoreIds attach and no propagation wait
 *   - it is genuinely API-invocable: :query create_session -> :streamQuery stream_query
 *     (the earlier "Reasoning Engine Execution failed" 400s were a missing session
 *     plus class_method='query', which ADK-framework engines do not expose)
 *
 * npx tsx src/spikes/_e2e_adk_confluence_agent.ts <dataStoreId> [displayName]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { dataStoreResourcePath } from '../services/geminiDataStore.js';
import { deployReasoningEngine, registerAdkAgent, ensureReasoningEngineDiscoveryAccess } from '../services/adkDeployer.js';
import { resolveDestination } from '../services/gemini.js';

const DS_ID = process.argv[2] ?? 'e2e-itinfra-sales-confluence';
const DISPLAY = process.argv[3] ?? 'IT + Sales Knowledge Agent (ADK)';
const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const ENGINE_OVERRIDE = process.env.E2E_ENGINE ?? 'gemini-enterprise-17847887_1784788734248';
const USER_ID = 'cf-e2e-user';

const QUESTIONS = (process.env.E2E_QUESTIONS ?? [
  'What is the VPN access process?',
  'What does the security policy require?',
  'What is on the client onboarding checklist?',
  'What are the Q1 2026 revenue targets?',
  'What is the maternity leave policy?',
].join('|')).split('|');

const INSTRUCTION =
  'You are a company assistant grounded in the connected Confluence knowledge base ' +
  '(IT Infrastructure and Sales and Revenue spaces). Answer only from the connected ' +
  'data store and cite the Confluence page title you used. If the answer is not in the ' +
  'knowledge base, say: "I do not have that information in the knowledge base."';

async function saToken(): Promise<string> {
  const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const k = JSON.parse(raw) as { client_email: string; private_key: string };
  const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
  if (!access_token) throw new Error('no SA token');
  return access_token;
}

const token = await saToken();
const resolved = await resolveDestination(PROJECT, token);
const dest = { ...resolved, engine: ENGINE_OVERRIDE };
const resourcePath = dataStoreResourcePath(PROJECT, DS_ID);

console.log(`═══ target ═══`);
console.log(`  project    : ${PROJECT}`);
console.log(`  engine     : ${dest.engine}${resolved.engine !== dest.engine ? `  (resolveDestination said "${resolved.engine}" — cannot host agents)` : ''}`);
console.log(`  dataStore  : ${resourcePath}`);

// ── 1. RE runtime service agent needs Discovery Engine read, or queries 403 ────
console.log(`\n═══ 1. Grant RE runtime Discovery Engine access ═══`);
const grant = await ensureReasoningEngineDiscoveryAccess(PROJECT, token);
console.log(`  ${JSON.stringify(grant)}`);

// ── 2. Deploy the Reasoning Engine (2-5+ min) ────────────────────────────────
console.log(`\n═══ 2. Deploy Reasoning Engine ═══`);
const t0 = Number(process.env.E2E_T0 ?? 0);
const dep = await deployReasoningEngine(PROJECT, LOCATION, {
  name: 'e2e_itinfra_sales_kb',
  displayName: DISPLAY,
  description: 'Confluence knowledge agent (IT Infrastructure + Sales and Revenue) deployed via ADK.',
  model: 'gemini-2.5-flash',
  instruction: INSTRUCTION,
  tools: [],
  groundingDataStores: [resourcePath],
}, { scriptPath: 'scripts/adk_deploy.py', timeoutMs: 20 * 60_000 });

console.log(`  ok=${dep.ok}  ${dep.reasoningEngine ?? dep.error ?? ''}${t0 ? '' : ''}`);
if (!dep.ok || !dep.reasoningEngine) process.exit(1);
const reId = dep.reasoningEngine.split('/').pop()!;

// ── 3. Register into the Gemini Enterprise engine ─────────────────────────────
console.log(`\n═══ 3. Register as agent in engine ═══`);
const reg = await registerAdkAgent(dest, token, {
  reasoningEngine: dep.reasoningEngine,
  displayName: DISPLAY,
  description: 'Confluence knowledge agent (IT Infrastructure + Sales and Revenue).',
});
console.log(`  registered=${reg.registered} agentId=${reg.agentId ?? '-'} state=${reg.state ?? '-'} ${reg.error ?? ''}`);

// ── 4. Invoke it: create_session then stream_query ────────────────────────────
console.log(`\n═══ 4. Invoke over the API ═══`);
const AI = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1`;
const re = `${AI}/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${reId}`;
const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const cs = await fetch(`${re}:query`, {
  method: 'POST', headers: h,
  body: JSON.stringify({ class_method: 'create_session', input: { user_id: USER_ID } }),
});
const csT = await cs.text();
const sessionId = /"id":\s*"([^"]+)"/.exec(csT)?.[1] ?? '';
console.log(`  create_session [${cs.status}] session=${sessionId || '(none)'}`);
if (!sessionId) { console.log(`  ${csT.replace(/\s+/g, ' ').slice(0, 300)}`); process.exit(1); }

for (const q of QUESTIONS) {
  const r = await fetch(`${re}:streamQuery?alt=sse`, {
    method: 'POST', headers: h,
    body: JSON.stringify({ class_method: 'stream_query', input: { user_id: USER_ID, session_id: sessionId, message: q } }),
  });
  const t = await r.text();
  if (!r.ok) { console.log(`\n  Q: ${q}\n  FAIL ${r.status} ${t.replace(/\s+/g, ' ').slice(0, 300)}`); continue; }
  const texts = [...t.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => {
    try { return JSON.parse(`"${m[1]}"`) as string; } catch { return m[1]; }
  });
  const usedSearch = /vertex_ai_search|VertexAiSearch|grounding|search_results/i.test(t);
  console.log(`\n  Q: ${q}`);
  console.log(`  searchToolUsed=${usedSearch}`);
  console.log(`  A: ${texts.join('').replace(/\s+/g, ' ').slice(0, 400) || '(no text)'}`);
}

console.log(`\n════ done ════
  reasoningEngine : ${reId}
  agent           : ${reg.agentId ?? '-'}  state=${reg.state ?? '-'}
  dataStore       : ${DS_ID}
`);
