/** POC: prove the tool can PROGRAMMATICALLY register an adkAgentDefinition agent
 *  (Agent-Runtime-backed) via the REST API and get state=ENABLED (gallery-visible)
 *  — the gallery-critical step of the ADK path. Points at an already-deployed
 *  reasoning engine (the deploy step is separate, Python-side).
 *
 *  npx tsx src/spikes/_poc_adk_register.ts <project> <engineId> <reasoningEngineResource> <displayName> [delete]
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const [PROJECT, ENGINE, REASONING, DISPLAY = 'POC ADK Agent', ACTION] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

async function main() {
  if (!PROJECT || !ENGINE || !REASONING) throw new Error('usage: _poc_adk_register.ts <project> <engineId> <reasoningEngineResource> <displayName> [delete]');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // This is exactly what adkDeployer.registerAdkAgent() will send in the tool.
  const body = {
    displayName: DISPLAY,
    description: 'POC: migrated agent registered as ADK/Agent-Runtime type to test gallery visibility.',
    adkAgentDefinition: {
      provisionedReasoningEngine: { reasoningEngine: REASONING },
    },
  };
  const r = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const text = await r.text();
  console.log(`register adkAgentDefinition -> ${r.status}`);
  if (!r.ok) { console.log(text.replace(/\s+/g, ' ').slice(0, 500)); process.exit(0); }

  const j = JSON.parse(text) as { name?: string; state?: string };
  const id = j.name?.split('/').pop();
  console.log(`\n>>> Registered agent state = ${j.state}   id=${id}`);
  console.log(j.state === 'ENABLED'
    ? '✅ PROVEN: programmatic ADK registration yields ENABLED (gallery-visible).'
    : `⚠️ state=${j.state} (unexpected).`);

  if (ACTION === 'delete' && id) {
    const del = await fetch(`${BASE}/${id}`, { method: 'DELETE', headers: h });
    console.log(`(cleaned up: delete ${del.status})`);
  } else if (id) {
    console.log(`(left in place — check the gallery. To remove: _diag_agents.ts ${PROJECT} delete ${id})`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
