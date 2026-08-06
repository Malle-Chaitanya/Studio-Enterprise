/**
 * Register already-deployed v3 RE as an agent in mia's Gemini project.
 * RE was deployed by _test_adk_v3.ts but agent registration hit quota (10 agents existed).
 * All old agents deleted by _diag_list_agents.ts. Now re-register.
 *
 * Usage: cd server && npx tsx src/spikes/_register_v3.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { registerAdkAgent } from '../services/adkDeployer.js';

const GCP_PROJECT  = 'sonorous-lightning-t224x';
const GEMINI_ADMIN = 'mia@cloudfuze.com';
const AGENT_NAME   = 'Confluence Knowledge Agent';
const AGENT_DESC   = 'Answers questions using CloudFuze Confluence knowledge (Engineering, HR)';

// RE deployed by _test_adk_v3.ts (v3, with engine serving config grounding)
const NEW_RE = 'projects/231705905417/locations/us-central1/reasoningEngines/8180209830246481920';

const saToken = await getSaToken(GEMINI_ADMIN);
const dest    = await resolveDestination(GCP_PROJECT, saToken);

console.log('Registering v3 agent (RE already deployed)...');
const reg = await registerAdkAgent(dest, saToken, {
  reasoningEngine: NEW_RE,
  displayName: AGENT_NAME,
  description: AGENT_DESC,
});

if (!reg.registered) {
  console.error(`Register failed: ${reg.error}`);
  process.exit(1);
}
console.log(`Agent ID: ${reg.agentId}`);
console.log(`State:    ${reg.state}`);

// Share with all users
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';
const base = `${HOST}/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}`;
const shareRes = await fetch(`${base}/agents/${reg.agentId}?updateMask=sharingConfig`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
});
console.log(`Share ALL_USERS: ${shareRes.status} ${shareRes.ok ? '✓' : await shareRes.text()}`);

console.log('\n=== DONE ===');
console.log(`RE: ${NEW_RE}`);
console.log(`Agent: ${reg.agentId}`);
console.log('Test: business.gemini.google → "What is the leave policy?"');
