/**
 * Probe: find the real inner field of the undocumented `agentsSpec` on
 * assistants:streamAssist. The API recognises `agents_spec` (a wrong inner name
 * errors with "Unknown name X at 'agents_spec'") but no discovery doc (v1alpha,
 * v1beta, v1) declares it — so the only way to learn the shape is to brute-force
 * candidate names and read which one stops erroring.
 *
 * Run: cd server && npx tsx src/spikes/_probe_agents_spec.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const AGENT_ID = '10065544401725915235';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const Q = 'What is the sick leave policy?';

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
const full = `projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT_ID}`;

/** Candidate shapes for agentsSpec. Value is either the resource name or the bare id. */
const shapes: Array<[string, unknown]> = [
  ['agentIds', { agentIds: [AGENT_ID] }],
  ['agentId', { agentId: AGENT_ID }],
  ['agentNames', { agentNames: [full] }],
  ['agentName', { agentName: full }],
  ['agentResourceName', { agentResourceName: full }],
  ['agentSpecs[].agent', { agentSpecs: [{ agent: full }] }],
  ['agentSpecs[].agentId', { agentSpecs: [{ agentId: AGENT_ID }] }],
  ['agentSpecs[].name', { agentSpecs: [{ name: full }] }],
  ['agentList.agents', { agentList: { agents: [full] } }],
  ['selectedAgents', { selectedAgents: [full] }],
  ['agentInfo.agent', { agentInfo: { agent: full } }],
];

console.log('=== brute-force agentsSpec inner field ===');
const accepted: string[] = [];
for (const [label, agentsSpec] of shapes) {
  const r = await fetch(`${assistant}:streamAssist`, {
    method: 'POST',
    headers: h,
    body: JSON.stringify({ query: { text: Q }, agentsSpec }),
  });
  const t = (await r.text()).replace(/\s+/g, ' ');
  const unknown = /Unknown name \\?"([^"\\]+)\\?"/.exec(t)?.[1];
  const verdict = r.ok ? 'ACCEPTED' : unknown ? `unknown field: ${unknown}` : `${r.status}`;
  console.log(`  ${label.padEnd(26)} -> ${String(r.status).padEnd(4)} ${verdict}`);
  if (r.ok) {
    accepted.push(label);
    console.log(`      ${t.slice(0, 700)}`);
  } else if (!unknown) {
    console.log(`      ${t.slice(0, 300)}`);
  }
}

console.log(`\naccepted shapes: ${accepted.length ? accepted.join(', ') : '(none)'}`);
