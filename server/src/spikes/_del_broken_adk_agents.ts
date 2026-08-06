/**
 * Delete today's broken ADK builds — both the Agentspace agent AND its Reasoning
 * Engine, which bills separately and is NOT removed by deleting the agent.
 *
 * Dry run by default; pass --apply to actually delete. Every id is verified by
 * display name before deletion, so a stale id in this list can never delete a
 * different agent than intended.
 *
 * Broken because:
 *   wrapper build  — deployed as ReasoningEngineAgentWrapper (framework=custom), so it
 *                    lacks create_session/streaming_agent_run_with_events and the
 *                    Gemini Enterprise UI 400s on it.
 *   ImportError    — deployed before google-cloud-discoveryengine was added to the
 *                    requirements; with 2+ tools ADK wraps VertexAiSearchTool as
 *                    DiscoveryEngineSearchTool, whose import fails at inference, so
 *                    every answer comes back empty.
 *
 * npx tsx src/spikes/_del_broken_adk_agents.ts [--apply]
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const APPLY = process.argv.includes('--apply');
const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const ENGINE = process.env.E2E_ENGINE ?? 'gemini-enterprise-17847887_1784788734248';
const LOCATION = 'us-central1';
const DE = 'https://discoveryengine.googleapis.com/v1alpha';
const AI = `https://${LOCATION}-aiplatform.googleapis.com/v1beta1`;

interface Target {
  agentId: string;
  reasoningEngineId: string;
  expectName: string;
  reason: string;
}

const TARGETS: Target[] = [
  { agentId: '5184711521022733376', reasoningEngineId: '6377081129438019584', expectName: 'IT + Sales Knowledge Agent (ADK)', reason: 'wrapper build — UI 400s' },
  { agentId: '15513341764948022085', reasoningEngineId: '6156404747696865280', expectName: 'IT + Sales Agent w/ Live Confluence (ADK)', reason: 'ImportError — empty answers' },
  { agentId: '2794359955998477168', reasoningEngineId: '4681475869733027840', expectName: 'IT + Sales Agent w/ Live Confluence v2 (ADK)', reason: 'ImportError — empty answers' },
  { agentId: '5037385620824896871', reasoningEngineId: '5751107169512587264', expectName: 'Confluence Agent — Live + Cited (ADK)', reason: 'ImportError — empty answers' },
];

/** Never touch these — the two working agents. */
const KEEP = new Set(['1731617027314167057', '13332936524828407630']);

const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
const agentBase = `${DE}/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

console.log(`${APPLY ? 'APPLY' : 'DRY RUN'} — project=${PROJECT}\n`);

for (const t of TARGETS) {
  if (KEEP.has(t.agentId)) { console.log(`SKIP ${t.agentId} — on the keep list`); continue; }

  // Verify identity before destroying anything.
  const g = await fetch(`${agentBase}/${t.agentId}`, { headers: h });
  const gj = await g.json().catch(() => ({})) as { displayName?: string; state?: string };
  const actual = gj.displayName ?? '(not found)';
  const match = actual === t.expectName;

  console.log(`agent ${t.agentId}`);
  console.log(`  name   : ${actual}${match ? '' : `   ⚠ EXPECTED "${t.expectName}"`}`);
  console.log(`  reason : ${t.reason}`);

  if (g.status === 404) { console.log('  already gone\n'); continue; }
  if (!match) { console.log('  REFUSING to delete — name mismatch\n'); continue; }
  if (!APPLY) { console.log(`  would delete agent + reasoningEngine ${t.reasoningEngineId}\n`); continue; }

  const da = await fetch(`${agentBase}/${t.agentId}`, { method: 'DELETE', headers: h });
  console.log(`  delete agent           -> ${da.status}${da.ok ? '' : ' ' + (await da.text()).replace(/\s+/g, ' ').slice(0, 160)}`);

  // force=true also removes child resources (sessions) the RE accumulated.
  const dr = await fetch(`${AI}/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${t.reasoningEngineId}?force=true`, {
    method: 'DELETE', headers: h,
  });
  console.log(`  delete reasoningEngine -> ${dr.status}${dr.ok ? '' : ' ' + (await dr.text()).replace(/\s+/g, ' ').slice(0, 160)}\n`);
}

// Show what survives, so the result is auditable rather than asserted.
const list = await fetch(`${agentBase}?pageSize=100`, { headers: h });
const lj = await list.json() as { agents?: Array<{ name: string; displayName?: string; state?: string }> };
console.log('── remaining agents whose name mentions Confluence / IT + Sales ──');
for (const a of lj.agents ?? []) {
  if (!/confluence|IT \+ Sales/i.test(a.displayName ?? '')) continue;
  const id = a.name.split('/').pop()!;
  console.log(`  ${id.padEnd(22)} ${a.state?.padEnd(9)} ${a.displayName}${KEEP.has(id) ? '   ← keep' : ''}`);
}
