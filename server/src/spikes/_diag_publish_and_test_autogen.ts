/** Publish the code-generated DraftFollowUpEmail_AutoGen_v2 integration and test it
 *  with real values, confirming it behaves identically to the hand-built version --
 *  closing the full fetch->translate->upload->publish->test loop, all by code.
 *  npx tsx src/spikes/_diag_publish_and_test_autogen.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';
const INTEGRATION = 'DraftFollowUpEmail_AutoGen_v2';
const VERSION_ID = 'a24cfafa-859a-4c3b-b3df-24a2931a36cc';
const base = `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/integrations/${INTEGRATION}`;

// Publish.
const publishRes = await fetch(`${base}/versions/${VERSION_ID}:publish`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: '{}',
});
console.log('Publish status:', publishRes.status);
console.log((await publishRes.text()).slice(0, 500));

// Execute with real values.
const execRes = await fetch(
  `${base}:execute?triggerId=api_trigger/${INTEGRATION}_API_1`,
  {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ClientName: 'Meridian Foods Inc.',
      NewLimit: '2500000',
      NewRate: '3.25%',
      CovenantStatus: 'unchanged',
    }),
  },
);
console.log('\nExecute status:', execRes.status);
console.log(await execRes.text());
process.exit(0);
