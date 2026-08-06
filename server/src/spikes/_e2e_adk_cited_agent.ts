/**
 * Track B + citations: an ADK agent with BOTH indexed knowledge and a live
 * Confluence tool, required to cite its source for every claim.
 *
 * Citations have to come from the tools, not from the model's memory. Two paths:
 *   - indexed:  VertexAiSearchTool returns each chunk's document title/URI, so the
 *               model can name the page it used.
 *   - live:     confluence_live_search returns {title, space, url}, so the model can
 *               emit a real clickable link.
 * The instruction below forces a `Sources:` block naming which path each fact came
 * from — the distinction customers need in order to trust a migrated agent.
 *
 * Verification asserts citations are PRESENT, and separately that the live-only
 * questions (ENG / HR spaces, deliberately not indexed) got answered — that pair is
 * what proves the live tool executed rather than the index being consulted.
 *
 * npx tsx src/spikes/_e2e_adk_cited_agent.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { upsertSecret } from '../services/secretManager.js';
import { connectorSecretId } from '../services/connectorCredentials.js';
import { dataStoreResourcePath } from '../services/geminiDataStore.js';
import { deployReasoningEngine, registerAdkAgent } from '../services/adkDeployer.js';
import { resolveDestination } from '../services/gemini.js';
import { chatWithAdkAgent, createAdkSession, getReasoningEngineMethods } from '../services/adkAgentChat.js';

const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const ENGINE = process.env.E2E_ENGINE ?? 'gemini-enterprise-17847887_1784788734248';
const DS_ID = process.env.E2E_DATA_STORE ?? 'e2e-itinfra-sales-confluence';
const DISPLAY = process.env.E2E_AGENT_NAME ?? 'Confluence Agent — Live + Cited (ADK)';
const USER_ID = 'cf-e2e-user';

const BASE_URL = process.env.CONFLUENCE_BASE_URL ?? '';
const EMAIL = process.env.CONFLUENCE_EMAIL ?? '';
const TOKEN = process.env.CONFLUENCE_TOKEN ?? '';
if (!BASE_URL || !EMAIL || !TOKEN) {
  console.error('Missing CONFLUENCE_BASE_URL / CONFLUENCE_EMAIL / CONFLUENCE_TOKEN in server/.env');
  process.exit(1);
}

const INSTRUCTION = [
  'You are a company knowledge assistant with TWO sources:',
  '',
  '1. An INDEXED Confluence knowledge base covering the "IT Infrastructure" and "Sales and Revenue" spaces.',
  '   Prefer it for those topics — it is fast.',
  '2. A LIVE tool, confluence_live_search(query), which searches the whole company Confluence instance in',
  '   real time. It covers every space (including ones the index does not, such as Engineering and Human',
  '   Resources) and sees pages created or edited after indexing.',
  '',
  'RULES:',
  '- If the indexed knowledge base does not answer the question, you MUST call confluence_live_search before',
  '  saying you do not know. Never refuse without trying the live tool first.',
  '- If the user asks about anything recent, updated, or current, use confluence_live_search even when the',
  '  indexed base has something — the live copy wins.',
  '- NEVER answer from your own general knowledge. Every factual claim must come from one of the two sources.',
  '',
  'CITATIONS — required on every answer that states a fact:',
  'End the reply with a "Sources:" section, one line per source, in this exact format:',
  '  - [INDEXED] <Confluence page title>',
  '  - [LIVE] <Confluence page title> — <url>',
  'Use [LIVE] only for results returned by confluence_live_search, and include the url field it gives you.',
  'Use [INDEXED] for results from the indexed knowledge base, naming the document title.',
  '',
  'If neither source has the answer, reply exactly: "I do not have that information in Confluence." and add',
  'no Sources section.',
].join('\n');

async function saToken(): Promise<string> {
  const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const k = JSON.parse(raw) as { client_email: string; private_key: string };
  const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
  if (!access_token) throw new Error('no SA token');
  return access_token;
}

const token = await saToken();

// ── 1. Credentials (idempotent — new version each run, value never printed) ────
console.log('═══ 1. Confluence creds → Secret Manager ═══');
const secretIds = {
  base_url: connectorSecretId('confluence', 'base_url'),
  email: connectorSecretId('confluence', 'email'),
  api_token: connectorSecretId('confluence', 'api_token'),
};
for (const [field, secretId] of Object.entries(secretIds)) {
  await upsertSecret(token, PROJECT, secretId, field === 'base_url' ? BASE_URL : field === 'email' ? EMAIL : TOKEN);
  console.log(`  ${secretId} ✔`);
}

// ── 2. Deploy ─────────────────────────────────────────────────────────────────
console.log('\n═══ 2. Deploy (indexed store + live Confluence tool + citation rules) ═══');
const resolved = await resolveDestination(PROJECT, token);
const dest = { ...resolved, engine: ENGINE };
const dep = await deployReasoningEngine(PROJECT, LOCATION, {
  name: 'e2e_cited_confluence',
  displayName: DISPLAY,
  description: 'Confluence agent: indexed ITINFRA+SALES knowledge, live company-wide Confluence lookup, cited answers.',
  model: 'gemini-2.5-flash',
  instruction: INSTRUCTION,
  tools: [],
  groundingDataStores: [dataStoreResourcePath(PROJECT, DS_ID)],
  liveConnectors: [{ id: 'confluence', kind: 'confluence', name: 'Confluence', secretIds }],
}, { timeoutMs: 20 * 60_000 });

console.log(`  ok=${dep.ok} ${dep.reasoningEngine ?? dep.error ?? ''}`);
if (!dep.ok || !dep.reasoningEngine) process.exit(1);
const reId = dep.reasoningEngine.split('/').pop()!;
const info = await getReasoningEngineMethods(PROJECT, token, reId, LOCATION);
console.log(`  framework=${info?.framework}`);
console.log(`  methods=${info?.methods.join(', ')}`);

// ── 3. Register ───────────────────────────────────────────────────────────────
console.log('\n═══ 3. Register into engine ═══');
const reg = await registerAdkAgent(dest, token, {
  reasoningEngine: dep.reasoningEngine,
  displayName: DISPLAY,
  description: 'Indexed + live Confluence knowledge with cited answers.',
});
console.log(`  registered=${reg.registered} agentId=${reg.agentId ?? '-'} state=${reg.state ?? '-'} ${reg.error ?? ''}`);

// ── 4. Ask, and check citations + live-tool evidence ──────────────────────────
console.log('\n═══ 4. Questions ═══');
const sessionId = (await createAdkSession(PROJECT, token, reId, USER_ID, LOCATION)) ?? undefined;

const asks: Array<{ label: string; q: string; expectLive: boolean }> = [
  { label: 'indexed (ITINFRA)', q: 'What is the VPN access process?', expectLive: false },
  { label: 'indexed (SALES)', q: 'What is on the client onboarding checklist?', expectLive: false },
  { label: 'LIVE ONLY — ENG space, not indexed', q: 'What are the Python coding standards?', expectLive: true },
  { label: 'LIVE ONLY — HR space, not indexed', q: 'How many days of earned leave do I get?', expectLive: true },
  { label: 'in neither source', q: 'What is the current share price of Google?', expectLive: false },
];

let cited = 0;
let liveProven = 0;
for (const { label, q, expectLive } of asks) {
  const r = await chatWithAdkAgent(PROJECT, token, { reasoningEngineId: reId, message: q, userId: USER_ID, sessionId, location: LOCATION });
  console.log(`\n  [${label}]\n  Q: ${q}`);
  if (!r.ok) { console.log(`  FAIL: ${r.error}`); continue; }
  const answer = r.answer ?? '';
  const hasSources = /Sources:/i.test(answer);
  const hasLiveCite = /\[LIVE\]/i.test(answer);
  if (hasSources) cited++;
  if (expectLive && hasLiveCite) liveProven++;
  console.log(`  citations=${hasSources ? 'yes' : 'NO'}  liveCitation=${hasLiveCite ? 'yes' : 'no'}`);
  console.log(`  A: ${answer.slice(0, 700) || '(empty)'}`);
}

console.log(`\n════ summary ════
  agent           : ${reg.agentId ?? '-'}  "${DISPLAY}"  state=${reg.state ?? '-'}
  reasoningEngine : ${reId}
  answers with a Sources block : ${cited}/${asks.length}
  live-tool-proven answers     : ${liveProven}/${asks.filter((a) => a.expectLive).length}  (ENG/HR are NOT indexed — a
                                  cited [LIVE] answer there can only come from the live Confluence call)
`);
