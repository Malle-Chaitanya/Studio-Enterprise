/** Prove the paramKeyFor fix end-to-end without needing a live redeploy:
 *  1. Confirm the DEPLOYED TOOL's argument key (what orchestrator.ts now computes) matches
 *     the FLOW TRIGGER's own declared variable name (what flowMapper.ts's translateFlow
 *     computes) — these were the two independently-computed values that used to drift apart
 *     ("number" vs "NewLimit"), which is the actual root cause.
 *  2. Actually EXECUTE the real compiled Filter_array JavaScriptTask script (not a
 *     hand-written recreation) against the real rate sheet data extracted from the live
 *     Excel table earlier this session, feeding it the value under the now-correct key, and
 *     print the real computed result for a concrete scenario (Northgate, $1.5M).
 *  npx tsx src/spikes/_diag_prove_paramkey_fix.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { translateFlow, integrationNameForFlow, paramKeyFor } from '../services/flowMapper.js';

const APP_USER_ID = '6a5dfdff7cf05623332758b7';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const SOURCE_ID = '91206676-c49f-f111-aaad-0022480b169d';

await connectMongo();
const cached = await getCachedIR(APP_USER_ID, ENV_URL, SOURCE_ID);
if (!cached) throw new Error('NO_CACHED_IR');

const flow = (cached.ir.flows ?? []).find((f) => integrationNameForFlow(f.name) === 'GetRateSheetBand');
if (!flow) throw new Error('FLOW_NOT_FOUND');

// Step 1: the exact same computation orchestrator.ts now does for flowToolSpecs.
// `flow.inputParameters` at the orchestrator call site is MappedFlowIntegration's field,
// which translateFlow itself sets from flow.trigger?.inputSchema — reading the same source
// here for a faithful reproduction of the real orchestrator.ts code path.
const deployedToolArgKeys = (flow.trigger?.inputSchema ?? []).map((p) => paramKeyFor(p));
console.log('=== Step 1: key agreement ===');
console.log('Deployed tool will send its argument under key(s):', deployedToolArgKeys);

const result = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
const def = result.integrationDefinition as { triggerConfigs: { inputVariables: { names: string[] } }[] };
console.log('Flow trigger declares/expects variable name(s):   ', def.triggerConfigs[0].inputVariables.names);
console.log(
  deployedToolArgKeys.length && deployedToolArgKeys.every((k) => def.triggerConfigs[0].inputVariables.names.includes(k))
    ? '=> MATCH — the real value will reach the variable the filter script reads.'
    : '=> MISMATCH — still broken.',
);

// Step 2: actually run the real compiled filter script against the real sheet data
// (transcribed directly from the live Excel screenshot this session, 15 real rows).
const HEADERS = ['Risk Rating', 'Limit Band Min', 'Limit Band Max', 'Rate (SOFR +)', 'Approval Required'];
const ROWS: [string, string, string, string, string][] = [
  ['BBB', '0', '1000000', '3.25%', 'RM'],
  ['BBB', '1000000', '2500000', '3.00%', 'RM'],
  ['BBB', '2500000', '5000000', '2.75%', 'Relationship Pricing Committee'],
  ['BBB-', '0', '1000000', '3.50%', 'RM'],
  ['BBB-', '1000000', '2500000', '3.25%', 'RM'],
  ['BBB-', '2500000', '5000000', '3.00%', 'Relationship Pricing Committee'],
  ['BB+', '0', '1000000', '3.75%', 'RM'],
  ['BB+', '1000000', '2500000', '3.50%', 'RM'],
  ['BB+', '2500000', '5000000', '3.25%', 'Relationship Pricing Committee'],
  ['BB+', '5000000', '10000000', '3.00%', 'Credit Committee'],
  ['BB', '0', '1000000', '4.25%', 'RM'],
  ['BB', '1000000', '2500000', '4.00%', 'RM'],
  ['BB', '2500000', '5000000', '3.75%', 'Relationship Pricing Committee'],
  ['BB-', '0', '1000000', '4.75%', 'Relationship Pricing Committee'],
  ['BB-', '1000000', '2500000', '4.50%', 'Relationship Pricing Committee'],
];
const grid = [HEADERS, ...ROWS];

const def2 = result.integrationDefinition as { taskConfigs: { task: string; parameters: { script?: { value: { stringValue: string } } } }[] };
const script = def2.taskConfigs.find((t) => t.task === 'JavaScriptTask')!.parameters.script!.value.stringValue;

function runCompiledFilter(newLimit: number): unknown[] {
  const setValues: Record<string, string> = {};
  const event = {
    getParameter: (key: string) => (key === deployedToolArgKeys[0] ? newLimit : JSON.stringify({ text: grid })),
    setParameter: (key: string, value: string) => { setValues[key] = value; },
  };
  // eslint-disable-next-line no-new-func
  const runner = new Function('event', `${script}\nexecuteScript(event);`);
  runner(event);
  return JSON.parse(Object.values(setValues)[0] ?? '[]');
}

console.log('\n=== Step 2: real compiled filter, real data, Northgate scenario ($1.5M) ===');
const matches = runCompiledFilter(1_500_000);
console.log(`${matches.length} matching row(s):`);
console.log(JSON.stringify(matches, null, 2));
const bbRow = (matches as { 'Risk Rating': string }[]).find((r) => r['Risk Rating'] === 'BB');
console.log('\nNorthgate is risk rating BB — the row the agent should pick:', JSON.stringify(bbRow));
process.exit(0);
