/**
 * Read-only lookup: find WorkMate's real agent id + Reasoning Engine on the exact
 * destination the user's last migration run actually used
 * (project 72860638029, engine gemini-enterprise-17859664_1785966424764) —
 * the local adkDeployments Mongo records do not have an entry for this engine at all,
 * so bookkeeping cannot be trusted here; ask Discovery Engine directly.
 *
 * Lists agents, nothing else. No writes.
 *
 *   cd server && npx tsx src/spikes/_diag_find_workmate_current_dest.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { assistantBase } from '../services/gemini.js';
import type { GeminiDestination } from '../types.js';

const dest: GeminiDestination = {
  project: '72860638029',
  engine: 'gemini-enterprise-17859664_1785966424764',
  assistant: 'default_assistant',
};

const token = await getSaToken('zara@storefuze.com');
const res = await fetch(`${assistantBase(dest)}/agents?pageSize=100`, {
  headers: { Authorization: `Bearer ${token}` },
});
const text = await res.text();
if (!res.ok) {
  console.log(`LIST FAIL ${res.status}: ${text.slice(0, 500)}`);
  process.exit(0);
}
const json = JSON.parse(text) as {
  agents?: Array<{
    name?: string;
    displayName?: string;
    state?: string;
    adkAgentDefinition?: { provisionedReasoningEngine?: { reasoningEngine?: string } };
  }>;
};
const agents = json.agents ?? [];
console.log(`${agents.length} agent(s) on this destination:`);
for (const a of agents) {
  console.log(`- "${a.displayName}" id=${a.name?.split('/').pop()} state=${a.state}`);
  const re = a.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine;
  if (re) console.log(`  reasoningEngine: ${re}`);
}
const workmate = agents.find((a) => a.displayName === 'WorkMate');
if (workmate) {
  console.log('\n--- WorkMate found ---');
  console.log('full agent name:', workmate.name);
  console.log('state:', workmate.state);
  console.log(
    'reasoningEngine:',
    workmate.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine ?? '(none — not an ADK agent)',
  );
} else {
  console.log('\nWorkMate not found by displayName on this destination.');
}
