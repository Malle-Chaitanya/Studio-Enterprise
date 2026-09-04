import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { registerAdkAgent } from '../services/adkDeployer.js';
import type { GeminiDestination } from '../types.js';

const dest: GeminiDestination = {
  project: 'agentmigrations',
  engine: 'gemini-enterprise-app_1787446545912',
  assistant: 'default_assistant',
};
const REASONING_ENGINE = 'projects/505103737920/locations/us-central1/reasoningEngines/2958013383426703360';

async function main() {
  const token = await getSaToken();
  const result = await registerAdkAgent(dest, token, {
    reasoningEngine: REASONING_ENGINE,
    displayName: 'WorkMate',
    description: 'WorkMate enterprise assistant (re-registered onto its last known-good, verified Reasoning Engine after the previous agent entry was deleted from the console).',
  });
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
