// Deletes the two registered test agents created while verifying the
// 2026-08-04 ADK knowledge-parity fix. Does NOT delete their underlying
// Reasoning Engines — no delete helper exists for that in this codebase yet
// (see adkDeployer.ts) — print the gcloud commands for those instead.
//   npx tsx src/spikes/_diag_cleanup_verification_agents.ts
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { deleteAgent } from '../services/gemini.js';
import type { GeminiDestination } from '../types.js';

const DEST: GeminiDestination = {
  project: '231705905417',
  engine: 'gemini-enterprise-17847887_1784788734248',
  assistant: 'default_assistant',
};

const TARGETS = [
  { name: 'KB-Grounding-Test-Agent-ADK-Fix-Verify', agentId: '6298384429963311040', reasoningEngineId: '8898111758347010048' },
  { name: 'ADK-File-Grounding-Sanity-Check', agentId: '949440877033799490', reasoningEngineId: '1395114779147763712' },
];

async function main() {
  const saToken = await getSaToken();
  for (const t of TARGETS) {
    console.log(`Deleting registered agent for "${t.name}" (${t.agentId})...`);
    const del = await deleteAgent(DEST, saToken, t.agentId);
    console.log('  ->', JSON.stringify(del));
  }

  console.log('\nReasoning Engines still exist (no delete helper in this codebase) — delete manually:');
  for (const t of TARGETS) {
    console.log(
      `gcloud ai reasoning-engines delete ${t.reasoningEngineId} --project=${DEST.project} --region=us-central1  # ${t.name}`,
    );
  }
}
main().catch((e) => console.error('FAILED:', e.message));
