/**
 * Probe: make assistants:streamAssist answer FROM the agent + its data store.
 *
 * Known so far: `agentsSpec: { agentSpecs: [{ agentId }] }` is accepted (200) but the
 * reply claims no access to internal files — so either the agentId is ignored, or the
 * assist path needs the data store handed to it explicitly via toolsSpec.
 *
 * Controls:
 *   A. bogus agentId  -> if it errors, agentId IS validated/honored
 *   B. real agentId + vertexAiSearchSpec.dataStoreSpecs -> grounded?
 *   C. no agentId + vertexAiSearchSpec only -> is grounding independent of the agent?
 *
 * Run: cd server && npx tsx src/spikes/_probe_assist_grounded.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const PROJECT = 'studio-enterprise-migration';
const PROJECT_NUM = '231705905417';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const AGENT_ID = '10065544401725915235';
const DS_ID = 'cf-knowledge-eng-hr';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const Q = 'What is the sick leave policy?';

const DS_PATH = `projects/${PROJECT_NUM}/locations/global/collections/default_collection/dataStores/${DS_ID}`;

async function getSaToken(): Promise<string> {
  const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const c = new JWT({ email: key.client_email, key: key.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
  const { access_token } = await c.authorize();
  if (!access_token) throw new Error('no token');
  return access_token;
}

const token = await getSaToken();
const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
const assistant = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant`;

/** Concatenate every streamed groundedContent text chunk into the full answer. */
function joinAnswer(raw: string): { text: string; refs: number } {
  let text = '';
  let refs = 0;
  for (const m of raw.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)) {
    try { text += JSON.parse(`"${m[1]}"`); } catch { text += m[1]; }
  }
  refs = [...raw.matchAll(/"referenceId"|"documentMetadata"|"citationMetadata"/g)].length;
  return { text, refs };
}

async function run(label: string, body: unknown): Promise<void> {
  const r = await fetch(`${assistant}:streamAssist`, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const raw = await r.text();
  console.log(`\n──── ${label}  [${r.status}]`);
  if (!r.ok) { console.log(`  ${raw.replace(/\s+/g, ' ').slice(0, 300)}`); return; }
  const { text, refs } = joinAnswer(raw);
  console.log(`  citations/refs seen: ${refs}`);
  console.log(`  answer: ${text.slice(0, 700)}`);
}

const agentsSpec = { agentSpecs: [{ agentId: AGENT_ID }] };
const vertexAiSearchSpec = { dataStoreSpecs: [{ dataStore: DS_PATH }] };

// A. control — is agentId validated at all?
await run('A. bogus agentId (control)', { query: { text: Q }, agentsSpec: { agentSpecs: [{ agentId: '000000000000000000' }] } });

// B. real agent + explicit data store
await run('B. real agentId + vertexAiSearchSpec', { query: { text: Q }, agentsSpec, toolsSpec: { vertexAiSearchSpec } });

// C. data store only, no agent
await run('C. vertexAiSearchSpec only (no agent)', { query: { text: Q }, toolsSpec: { vertexAiSearchSpec } });

// D. real agent, no data store (repeat of the earlier 200, captured in full)
await run('D. real agentId only', { query: { text: Q }, agentsSpec });
