/** Static check of one flow's translation fidelity (no live execution needed) — reads the
 *  already-cached AgentIR for Deal Desk, finds the named flow, and re-runs translateFlow on
 *  it to see exactly which steps became real Application Integration tasks vs which were
 *  lost/needs-review. Useful for a flow with no execution history yet (never reached in a
 *  live chat test), where _diag_check_getratesheetband_execution.ts has nothing to check.
 *  npx tsx src/spikes/_diag_check_flow_translation.ts <FlowName> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { translateFlow, integrationNameForFlow } from '../services/flowMapper.js';

const APP_USER_ID = '6a5dfdff7cf05623332758b7';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const SOURCE_ID = '91206676-c49f-f111-aaad-0022480b169d'; // Deal Desk
const FLOW_NAME = process.argv[2] || 'GenerateAmendmentDocument';

await connectMongo();
const cached = await getCachedIR(APP_USER_ID, ENV_URL, SOURCE_ID);
if (!cached) throw new Error('NO_CACHED_IR — run extraction at least once first');

const flow = (cached.ir.flows ?? []).find((f) => integrationNameForFlow(f.name) === FLOW_NAME || f.name === FLOW_NAME);
if (!flow) {
  console.log(
    'Flows available:',
    (cached.ir.flows ?? []).map((f) => `${f.name} (${f.actions.length} actions)`),
  );
  throw new Error(`FLOW_NOT_FOUND: ${FLOW_NAME}`);
}

console.log(`Flow "${flow.name}" — ${flow.actions.length} action(s):`);
for (const a of flow.actions) console.log(`  - ${a.id}: ${a.kind}${'connectorId' in a ? ` (${(a as { connectorId?: string }).connectorId})` : ''}`);

const result = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
const def = result.integrationDefinition as { triggerConfigs?: { position?: unknown }[]; taskConfigs?: unknown[] } | undefined;
console.log(`\nintegrationDefinition: ${def?.taskConfigs?.length ?? 'unknown'} task(s) built.`);
console.log(`\nFidelity notes (${result.fidelityNotes.length}):`);
for (const n of result.fidelityNotes) {
  console.log(`  [${n.status}] ${n.component}: ${n.detail}`);
}
process.exit(0);
