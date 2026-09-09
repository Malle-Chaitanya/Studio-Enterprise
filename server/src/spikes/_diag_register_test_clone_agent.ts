/** Register the already-deployed "Deal Desk - TEST CLONE" Reasoning Engine into the
 *  Gemini Enterprise App's Agents gallery, so it's visible/chattable in the console UI
 *  the user is actually looking at (not just via the raw Vertex AI API).
 *  npx tsx src/spikes/_diag_register_test_clone_agent.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { registerAdkAgent } from '../services/adkDeployer.js';

const saToken = await getSaToken();
const dest = await resolveDestination('agentmigrations', saToken);
console.log('Destination:', JSON.stringify(dest));

const REASONING_ENGINE = 'projects/505103737920/locations/us-central1/reasoningEngines/969916040500740096';

const result = await registerAdkAgent(dest, saToken, {
  reasoningEngine: REASONING_ENGINE,
  displayName: 'Deal Desk - TEST CLONE (safe to delete)',
  description:
    'THIS IS A TEST CLONE, NOT THE REAL DEAL DESK AGENT. Safe to delete. Has two migrated ' +
    'Application Integration tools wired up: draft_follow_up_email and get_rate_sheet_band, ' +
    'used to prove migrated Copilot Studio flows can be called by a real Gemini agent.',
});
console.log(JSON.stringify(result, null, 2));
process.exit(0);
