import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const gcpToken = await getSaToken();
const execRes = await fetch(
  'https://integrations.googleapis.com/v2/projects/agentmigrations/locations/us-east1/integrations/GetRateSheetBand_AutoGen_v3:execute?triggerId=api_trigger/GetRateSheetBand_AutoGen_v3_API_1',
  { method: 'POST', headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ NewLimit: '2,500,000' }) },
);
console.log('Status:', execRes.status);
console.log(await execRes.text());
process.exit(0);
