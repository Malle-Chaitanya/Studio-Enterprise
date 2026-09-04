import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const INTEGRATION = 'DraftFollowUpEmail_AutoGen_v2';

const execRes = await fetch(
  `https://integrations.googleapis.com/v2/projects/agentmigrations/locations/us-east1/integrations/${INTEGRATION}:execute?triggerId=api_trigger/${INTEGRATION}_API_1`,
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
console.log('Execute status:', execRes.status);
console.log(await execRes.text());
process.exit(0);
