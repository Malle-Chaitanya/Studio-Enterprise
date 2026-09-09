/** Re-test the already-published GetRateSheetBand_Generic_v1 integration, isolated from
 *  the upload/publish steps, to check whether the earlier empty result for 500000 was a
 *  propagation-delay artifact or a real bug.
 *  npx tsx src/spikes/_diag_retest_generic_getratesheetband.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';
const INTEGRATION = 'GetRateSheetBand_Generic_v1';
const gToken = await getSaToken();

for (const NewLimit of ['500000', '2000000', '500000']) {
  const execRes = await fetch(
    `https://integrations.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}:execute?triggerId=api_trigger/${INTEGRATION}_API_1`,
    { method: 'POST', headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ NewLimit }) },
  );
  console.log(`\nExecute (NewLimit=${NewLimit}) status:`, execRes.status);
  console.log((await execRes.text()).slice(0, 1500));
}
process.exit(0);
