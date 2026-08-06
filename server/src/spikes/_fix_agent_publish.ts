/**
 * Try all known ways to publish/share the Confluence Knowledge Agent.
 * Run: cd server && npx tsx src/spikes/_fix_agent_publish.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const GCP_PROJECT = 'studio-enterprise-migration';
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const GEMINI_ENGINE = 'gemini-enterprise-17847887_1784788734248';
const AGENT_ID = '10065544401725915235';

async function getSaToken(): Promise<string> {
  const keyRaw = config.GOOGLE_SA_KEY_JSON?.trim()
    ? config.GOOGLE_SA_KEY_JSON
    : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
  const key = JSON.parse(keyRaw) as { client_email: string; private_key: string };
  const client = new JWT({
    email: key.client_email, key: key.private_key,
    scopes: ['https://www.googleapis.com/auth/cloud-platform'],
  });
  const { access_token } = await client.authorize();
  if (!access_token) throw new Error('No token');
  return access_token;
}

const saToken = await getSaToken();
const collBase = `${HOST}/projects/${GCP_PROJECT}/locations/global/collections/default_collection`;
const engineBase = `${collBase}/engines/${GEMINI_ENGINE}`;
const agentBase = `${engineBase}/assistants/default_assistant/agents`;
const agentName = `${agentBase}/${AGENT_ID}`;

// ── 1. Current state ─────────────────────────────────────────────────────────
console.log('═══ 1. Current agent state ═══');
const getR = await fetch(agentName, { headers: { Authorization: `Bearer ${saToken}` } });
const getJ = await getR.json() as Record<string, unknown>;
console.log(`State: ${getJ['state']}`);
console.log(`Display name: ${getJ['displayName']}`);

// ── 2. Try PATCH with state=PUBLISHED ────────────────────────────────────────
console.log('\n═══ 2. PATCH state → PUBLISHED ═══');
const patchR = await fetch(`${agentName}?updateMask=state`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ state: 'PUBLISHED' }),
});
console.log(`PATCH status: ${patchR.status}`);
const patchT = await patchR.text();
if (patchR.ok) {
  const pj = JSON.parse(patchT) as Record<string, unknown>;
  console.log(`New state: ${pj['state']}`);
} else {
  console.log(`Response: ${patchT.slice(0, 300)}`);
}

// ── 3. Try :publish again (different body) ───────────────────────────────────
console.log('\n═══ 3. :publish with engineId in body ═══');
const pub2R = await fetch(`${agentName}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ publishToAgentspace: true }),
});
console.log(`Publish2 status: ${pub2R.status}`);
const pub2T = await pub2R.text();
console.log(`Response: ${pub2T.slice(0, 200)}`);

// ── 4. Check final state ─────────────────────────────────────────────────────
console.log('\n═══ 4. Final state check ═══');
const finalR = await fetch(agentName, { headers: { Authorization: `Bearer ${saToken}` } });
const finalJ = await finalR.json() as Record<string, unknown>;
console.log(`State: ${finalJ['state']}`);

// ── 5. List all agents + their states ────────────────────────────────────────
console.log('\n═══ 5. All agents in engine ═══');
const listR = await fetch(agentBase, { headers: { Authorization: `Bearer ${saToken}` } });
const listJ = await listR.json() as { agents?: Array<{ name: string; displayName?: string; state?: string }> };
for (const a of listJ.agents ?? []) {
  const id = a.name.split('/').pop()!;
  console.log(`  ${a.state?.padEnd(10)} ${id}  ${a.displayName ?? ''}`);
}

// ── 6. Check if engine/assistant has its own ACL/share API ───────────────────
console.log('\n═══ 6. Check engine-level sharing config ═══');
const engR = await fetch(`${engineBase}`, { headers: { Authorization: `Bearer ${saToken}` } });
const engJ = await engR.json() as Record<string, unknown>;
console.log('Engine fields:', Object.keys(engJ).join(', '));
const solutionType = engJ['solutionType'];
const displayName = engJ['displayName'];
console.log(`Engine: ${displayName} (${solutionType})`);

// ── 7. Try assistant-level publish ───────────────────────────────────────────
console.log('\n═══ 7. Assistant-level info ═══');
const assistR = await fetch(`${engineBase}/assistants/default_assistant`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
const assistT = await assistR.text();
console.log(`Assistant: ${assistR.status} — ${assistT.slice(0, 300)}`);

console.log(`
══════════════════════════════════════════════════════════
  If state is still PRIVATE, admin must publish via UI:
  → console.cloud.google.com/gemini-enterprise
  → Project: studio-enterprise-migration
  → Apps → gemini-enterprise-17847887_1784788734248 → Agents
  → "Confluence Knowledge Agent" → click Publish button
══════════════════════════════════════════════════════════
`);
