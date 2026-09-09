/** Test the live GetRateSheetBand_Generic_v1 integration directly with a $4M limit in
 *  several input formats, to isolate the tool's own logic from the agent/LLM layer.
 *  npx tsx src/spikes/_diag_test_4m.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';
const INTEGRATION = 'GetRateSheetBand_Generic_v1';
const gToken = await getSaToken();

for (const NewLimit of ['4000000', '4,000,000', '$4,000,000', '4000000.0']) {
  const execRes = await fetch(
    `https://integrations.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}:execute?triggerId=api_trigger/${INTEGRATION}_API_1`,
    { method: 'POST', headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ NewLimit }) },
  );
  console.log(`\nExecute (NewLimit=${JSON.stringify(NewLimit)}) status:`, execRes.status);
  console.log((await execRes.text()).slice(0, 1500));
}
process.exit(0);
