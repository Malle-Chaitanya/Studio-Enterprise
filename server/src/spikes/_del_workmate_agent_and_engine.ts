/**
 * Confirmed-target deletion of WorkMate's Discovery Engine agent AND its underlying
 * Reasoning Engine, per explicit user request (2026-08-25) — resolved live because the
 * migration progress log's "Destination engine" line did not match where the agent
 * actually was (see _diag_find_workmate_current_dest.ts / _diag_find_workmate_mongo_dest.ts).
 *
 * Target, confirmed against a live GET before this ran:
 *   agent:            projects/231705905417/.../engines/geminienterpriseapp_1787403755425
 *                     /assistants/default_assistant/agents/7877017947278153960
 *   reasoning engine: projects/231705905417/locations/us-central1/reasoningEngines/236163552774193152
 *
 *   cd server && npx tsx src/spikes/_del_workmate_agent_and_engine.ts
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
const AGENT_ID = '7877017947278153960';
const REASONING_ENGINE = 'projects/231705905417/locations/us-central1/reasoningEngines/236163552774193152';
const LOCATION = 'us-central1';

const token = await getSaToken('zara@storefuze.com');

console.log('--- deleting Discovery Engine agent ---');
const agentRes = await fetch(`${assistantBase(dest)}/agents/${AGENT_ID}`, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${token}` },
});
console.log(`agent delete: ${agentRes.status}`);
if (!agentRes.ok && agentRes.status !== 404) {
  console.log(await agentRes.text());
}

console.log('\n--- deleting Reasoning Engine (force=true) ---');
const reRes = await fetch(
  `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${REASONING_ENGINE}?force=true`,
  { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } },
);
console.log(`reasoning engine delete: ${reRes.status}`);
if (!reRes.ok && reRes.status !== 404) {
  console.log(await reRes.text());
}

console.log('\ndone.');
