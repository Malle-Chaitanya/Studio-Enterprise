/** Call any migrated flow with the flat-kwargs body the deployed agent uses.
 *   FLOW=GenerateAmendmentDocument ARGS='{"ClientName":"Atlas Industrial Group"}' npx tsx src/spikes/_probe_flow_call.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const P = process.env.FLOW_PROJECT || 'agentmigrations', L = 'us-east1';
const F = process.env.FLOW || 'GetRateSheetBand';
const ARGS = JSON.parse(process.env.ARGS || '{"NewLimit":5000000}');
const token = await getSaToken(process.env.SUBJECT || 'admin@migrationn.com');
const url = `https://integrations.googleapis.com/v2/projects/${P}/locations/${L}/integrations/${F}:execute?triggerId=api_trigger/${F}_API_1`;
const r = await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(ARGS) });
const t = await r.text();
console.log(`${F} HTTP ${r.status}`);
console.log(t.slice(0, 1200));
process.exit(0);
