/**
 * Probe: can a low-code agent be INVOKED over the API (not just the UI), and
 * does anything flip state PRIVATE -> ENABLED?
 *
 * Handoff claimed "no chat API" based on `sessions/{id}/answers` -> 404. That is
 * the wrong surface. The discovery doc exposes two untried endpoints:
 *   - engines/*\/assistants/default_assistant:streamAssist   (the real assist API)
 *   - engines/*\/servingConfigs/default_search:answer        (engine-level grounded answer)
 * Agent selection is not in the public StreamAssistRequest schema, so we brute-force
 * the plausible undocumented field names (lowCodeAgentDefinition is undocumented too).
 *
 * Run: cd server && npx tsx src/spikes/_probe_assist_agent.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const AGENT_ID = '10065544401725915235';
const DS_ID = 'cf-knowledge-eng-hr';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const Q = 'What is the sick leave policy?';

async function getSaToken(): Promise<string> {
  const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const client = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const { access_token } = await client.authorize();
  if (!access_token) throw new Error('no token');
  return access_token;
}

const token = await getSaToken();
const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const collBase = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection`;
const engineBase = `${collBase}/engines/${ENGINE}`;
const assistant = `${engineBase}/assistants/default_assistant`;
const agentName = `${assistant.replace(`${HOST}/`, '')}/agents/${AGENT_ID}`;

function brief(t: string, n = 400): string {
  return t.replace(/\s+/g, ' ').slice(0, n);
}

async function post(label: string, url: string, body: unknown): Promise<void> {
  const r = await fetch(url, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const t = await r.text();
  const mark = r.ok ? 'OK  ' : 'FAIL';
  console.log(`\n[${mark}] ${label}  -> ${r.status}`);
  console.log(`  ${brief(t, r.ok ? 900 : 400)}`);
}

// ── 0. current agent state ────────────────────────────────────────────────────
console.log('=== 0. agent state ===');
const g = await fetch(`${assistant}/agents/${AGENT_ID}`, { headers: h });
const gj = await g.json() as Record<string, unknown>;
console.log(`state=${gj['state']}  sharingConfig=${JSON.stringify(gj['sharingConfig'] ?? {})}`);
console.log(`agent resource: ${agentName}`);

// ── 1. assistant GET (what tools/config does it advertise?) ───────────────────
console.log('\n=== 1. assistant config ===');
const a = await fetch(assistant, { headers: h });
console.log(`${a.status}  ${brief(await a.text(), 900)}`);

// ── 2. streamAssist, no agent selection (does assist work at all?) ────────────
console.log('\n=== 2. streamAssist (engine default, no agent) ===');
await post('streamAssist bare', `${assistant}:streamAssist`, {
  query: { text: Q },
  answerGenerationMode: 'NORMAL',
});

// ── 3. streamAssist with candidate agent-selection field names ────────────────
console.log('\n=== 3. streamAssist + agent selection (brute-force field names) ===');
const candidates: Array<[string, Record<string, unknown>]> = [
  ['agentsSpec.agentResourceNames', { agentsSpec: { agentResourceNames: [agentName] } }],
  ['agentsSpec.agents[].agent', { agentsSpec: { agents: [{ agent: agentName }] } }],
  ['agentSpec.agent', { agentSpec: { agent: agentName } }],
  ['agent', { agent: agentName }],
  ['assistSkippingMode+agent', { agent: agentName, assistSkippingMode: 'REQUEST_ASSIST' }],
];
for (const [label, extra] of candidates) {
  await post(label, `${assistant}:streamAssist`, { query: { text: Q }, ...extra });
}

// ── 4. engine-level :answer (never tried — only data-store level was) ─────────
console.log('\n=== 4. engine servingConfigs:answer ===');
await post('engine :answer', `${engineBase}/servingConfigs/default_search:answer`, {
  query: { text: Q },
  answerGenerationSpec: { includeCitations: true, modelSpec: { modelVersion: 'stable' } },
});

// ── 5. data-store-level :answer (distinct from :search summarySpec) ───────────
console.log('\n=== 5. dataStore servingConfigs:answer ===');
await post('dataStore :answer', `${collBase}/dataStores/${DS_ID}/servingConfigs/default_search:answer`, {
  query: { text: Q },
  answerGenerationSpec: { includeCitations: true },
});

// ── 6. re-check state (did any successful invoke flip it?) ────────────────────
console.log('\n=== 6. agent state after probes ===');
const g2 = await fetch(`${assistant}/agents/${AGENT_ID}`, { headers: h });
const gj2 = await g2.json() as Record<string, unknown>;
console.log(`state=${gj2['state']}  sharingConfig=${JSON.stringify(gj2['sharingConfig'] ?? {})}`);
