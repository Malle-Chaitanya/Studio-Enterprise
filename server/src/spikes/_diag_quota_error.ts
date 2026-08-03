/** Trigger the agent-creation 429 and print the COMPLETE error JSON — Google's
 *  RESOURCE_EXHAUSTED errors usually include a `details` array (QuotaFailure /
 *  ErrorInfo / Help) that names the exact quota metric, the limit value, and a
 *  help link. This is the hard evidence of what limit we're hitting.
 *   npx tsx src/spikes/_diag_quota_error.ts <project> <engineId> <reasoningEngine> */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const [PROJECT, ENGINE, REASONING] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

async function main() {
  if (!PROJECT || !ENGINE) throw new Error('usage: _diag_quota_error.ts <project> <engineId> [reasoningEngine]');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // Minimal create body (adk if a reasoning engine is given, else a bare low-code agent).
  const body = REASONING
    ? { displayName: 'ZZ quota-probe', description: 'probe', adkAgentDefinition: { provisionedReasoningEngine: { reasoningEngine: REASONING } } }
    : { displayName: 'ZZ quota-probe', description: 'probe', lowCodeAgentDefinition: { rootAgentId: 'root_agent', nodes: [{ id: 'root_agent', displayName: 'p', llmAgentNode: { description: 'p', model: 'gemini-2.0-flash', instruction: 'test', subAgentIds: [], selectedTools: { tool: [] } } }], draftDisplayName: 'p', draftDescription: 'p', draftStarterPrompts: [], draftIcon: { content: '' }, deployedNodes: [], agentFiles: [], draftSchedules: [], deployedSchedules: [] } };

  const r = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify(body) });
  console.log(`create -> ${r.status}\n`);
  const j = await r.json();
  console.log('===== FULL ERROR JSON =====');
  console.log(JSON.stringify(j, null, 2));

  // If it unexpectedly succeeded, clean up.
  if (r.ok && (j as { name?: string }).name) {
    const id = (j as { name: string }).name.split('/').pop();
    await fetch(`${BASE}/${id}`, { method: 'DELETE', headers: h });
    console.log(`\n(unexpectedly created — cleaned up ${id})`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
