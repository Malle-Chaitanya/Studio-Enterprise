/**
 * Read-only: check whether WorkMate actually lives at the destination the local
 * adkDeployments record points to (project studio-enterprise-migration, engine
 * geminienterpriseapp_1787403755425, agentId 7877017947278153960) — since the
 * destination named in the migration progress log (72860638029 /
 * gemini-enterprise-17859664_1785966424764) does NOT have it.
 *
 *   cd server && npx tsx src/spikes/_diag_find_workmate_mongo_dest.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { assistantBase } from '../services/gemini.js';
import type { GeminiDestination } from '../types.js';

const dest: GeminiDestination = {
  project: 'studio-enterprise-migration',
  engine: 'geminienterpriseapp_1787403755425',
  assistant: 'default_assistant',
};

const token = await getSaToken('zara@storefuze.com');

// Direct get by the id Mongo recorded.
const AGENT_ID = '7877017947278153960';
const getRes = await fetch(`${assistantBase(dest)}/agents/${AGENT_ID}`, {
  headers: { Authorization: `Bearer ${token}` },
});
const getText = await getRes.text();
console.log(`GET agents/${AGENT_ID}: ${getRes.status}`);
console.log(getText.slice(0, 800));

console.log('\n--- full list on this destination ---');
const listRes = await fetch(`${assistantBase(dest)}/agents?pageSize=100`, {
  headers: { Authorization: `Bearer ${token}` },
});
const listText = await listRes.text();
if (!listRes.ok) {
  console.log(`LIST FAIL ${listRes.status}: ${listText.slice(0, 500)}`);
  process.exit(0);
}
const json = JSON.parse(listText) as {
  agents?: Array<{
    name?: string;
    displayName?: string;
    state?: string;
    adkAgentDefinition?: { provisionedReasoningEngine?: { reasoningEngine?: string } };
  }>;
};
const agents = json.agents ?? [];
console.log(`${agents.length} agent(s):`);
for (const a of agents) {
  console.log(`- "${a.displayName}" id=${a.name?.split('/').pop()} state=${a.state}`);
  const re = a.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine;
  if (re) console.log(`  reasoningEngine: ${re}`);
}
