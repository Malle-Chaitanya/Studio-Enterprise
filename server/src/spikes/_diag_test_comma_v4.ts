/** Verify the INT_VALUE + defensive-parsing fix handles comma-formatted input.
 *  npx tsx src/spikes/_diag_test_comma_v4.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const gcpToken = await getSaToken();
const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';
const INTEGRATION = 'GetRateSheetBand_AutoGen_v4';

const res = await fetch(
  `https://integrations.googleapis.com/v2/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}:execute?triggerId=api_trigger/${INTEGRATION}_API_1`,
  { method: 'POST', headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ NewLimit: '2,500,000' }) },
);
console.log('Execute status (NewLimit="2,500,000"):', res.status);
console.log((await res.text()).slice(0, 2000));
process.exit(0);
