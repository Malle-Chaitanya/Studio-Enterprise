/**
 * Repoint an EXISTING gallery agent at a newly-deployed Reasoning Engine.
 *
 * This is what the real pipeline does via `existingAgentId` — it is why a re-migration
 * updates the agent the customer already has instead of leaving a second one beside it.
 *
 * WRITES: PATCHes one agent. npx tsx src/spikes/_repoint_agent.ts <agentId> <reasoningEngineId>
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { resolveDestination } from '../services/gemini.js';
import { updateAdkAgentReasoningEngine } from '../services/adkDeployer.js';

const PROJECT = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const AGENT_ID = process.argv[2]!;
const ENGINE_ID = process.argv[3]!;
const saToken = await getSaToken();
const dest = await resolveDestination(PROJECT, saToken);
const engine = `projects/${dest.project.match(/^\d+$/) ? dest.project : '231705905417'}/locations/us-central1/reasoningEngines/${ENGINE_ID}`;
const r = await updateAdkAgentReasoningEngine(dest, saToken, AGENT_ID, engine);
console.log(JSON.stringify({ ...r, engine }, null, 2));
process.exit(0);
