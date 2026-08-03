/** Deliberately exhaust the agent-creation quota to identify the REAL blocker.
 *  Creates throwaway low-code probe agents in a loop, counting successes, until
 *  it hits a non-2xx (expected: 429 RESOURCE_EXHAUSTED). On the first failure it
 *  prints the COMPLETE error JSON — Google's RESOURCE_EXHAUSTED usually includes a
 *  `details[]` array (QuotaFailure / ErrorInfo / Help) naming the exact quota
 *  metric, limit value, and a help link. Always cleans up everything it created.
 *
 *  The success COUNT ≈ the daily agent-creation limit; the error JSON names the
 *  metric. Together they make docs/SUPPORT-TICKET-AGENT-QUOTA.md precise.
 *
 *  WARNING: this burns the target project's daily agent-creation quota. Deleting
 *  the probe agents does NOT restore it (the quota is cumulative per day), so real
 *  migrations on the project are blocked until the next reset (~midnight PT).
 *
 *    npx tsx src/_diag_quota_probe_loop.ts <project> <engineId> [maxAttempts]
 */
import 'dotenv/config';
import { getSaToken } from './auth/google.js';

const [PROJECT, ENGINE, MAX_ARG] = process.argv.slice(2);
const MAX = Number(MAX_ARG) || 150; // safety cap so we never loop forever
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

function probeBody(i: number) {
  return {
    displayName: `ZZ quota-probe ${i}`,
    description: 'probe (auto-cleanup)',
    lowCodeAgentDefinition: {
      rootAgentId: 'root_agent',
      nodes: [{ id: 'root_agent', displayName: 'p', llmAgentNode: { description: 'p', model: 'gemini-2.0-flash', instruction: 'test', subAgentIds: [], selectedTools: { tool: [] } } }],
      draftDisplayName: 'p', draftDescription: 'p', draftStarterPrompts: [], draftIcon: { content: '' },
      deployedNodes: [], agentFiles: [], draftSchedules: [], deployedSchedules: [],
    },
  };
}

async function main() {
  if (!PROJECT || !ENGINE) throw new Error('usage: _diag_quota_probe_loop.ts <project> <engineId> [maxAttempts]');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const created: string[] = [];
  let blocked = false;

  console.log(`Probing agent-creation quota on ${PROJECT} / ${ENGINE} (max ${MAX} attempts)...\n`);

  for (let i = 1; i <= MAX; i++) {
    const r = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify(probeBody(i)) });
    const j: unknown = await r.json();

    if (r.ok && (j as { name?: string }).name) {
      const id = (j as { name: string }).name.split('/').pop()!;
      created.push(id);
      console.log(`  #${i}: 200 OK  (created ${id}) — total success: ${created.length}`);
      continue;
    }

    // First non-2xx — this is what we came for.
    blocked = true;
    console.log(`\n  #${i}: ${r.status} — BLOCKED after ${created.length} successful creations this run.\n`);
    console.log('===== FULL ERROR JSON (name the quota metric) =====');
    console.log(JSON.stringify(j, null, 2));
    break;
  }

  if (!blocked) {
    console.log(`\nReached max ${MAX} attempts WITHOUT a block — the daily limit is higher than ${MAX}, or already high. Successes: ${created.length}.`);
  }

  // Always clean up every probe agent we created.
  console.log(`\nCleaning up ${created.length} probe agent(s)...`);
  let cleaned = 0;
  for (const id of created) {
    try {
      const dr = await fetch(`${BASE}/${id}`, { method: 'DELETE', headers: h });
      if (dr.ok) cleaned++;
    } catch { /* best-effort */ }
  }
  console.log(`Cleaned up ${cleaned}/${created.length}.`);

  console.log(`\n===== SUMMARY =====`);
  console.log(`Successful creations before block: ${created.length}${blocked ? '' : ' (no block hit)'}`);
  console.log(`≈ this is the remaining daily agent-creation allowance at run start.`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
