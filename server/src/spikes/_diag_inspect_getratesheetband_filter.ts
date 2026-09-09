/** Dump GetRateSheetBand's raw WDL Query (from/where) and the compiled JavaScriptTask script,
 *  to find exactly why it only ever returns the first ("0 to 1,000,000") band for each risk
 *  rating regardless of the requested limit — the real sheet clearly has bands up to $10M
 *  (see the real screenshot), so this is a translation bug, not a data gap.
 *  npx tsx src/spikes/_diag_inspect_getratesheetband_filter.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { translateFlow, integrationNameForFlow } from '../services/flowMapper.js';

const APP_USER_ID = '6a5dfdff7cf05623332758b7';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const SOURCE_ID = '91206676-c49f-f111-aaad-0022480b169d'; // Deal Desk

await connectMongo();
const cached = await getCachedIR(APP_USER_ID, ENV_URL, SOURCE_ID);
if (!cached) throw new Error('NO_CACHED_IR');

const flow = (cached.ir.flows ?? []).find((f) => integrationNameForFlow(f.name) === 'GetRateSheetBand');
if (!flow) throw new Error('FLOW_NOT_FOUND');

console.log('=== Raw actions ===');
for (const a of flow.actions) {
  console.log(`\n--- ${a.id} (${a.type}) ---`);
  console.log(JSON.stringify(a.raw, null, 2).slice(0, 3000));
}

console.log('\n\n=== Compiled JavaScriptTask script(s) ===');
const result = translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) });
const def = result.integrationDefinition as { taskConfigs: { task: string; displayName: string; parameters: { script?: { value: { stringValue: string } } } }[] };
for (const t of def.taskConfigs) {
  if (t.task === 'JavaScriptTask') {
    console.log(`\n--- ${t.displayName} ---`);
    console.log(t.parameters.script!.value.stringValue);
  }
}
process.exit(0);
