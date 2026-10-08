/** The body shape the DEPLOYED agent really sends (adk_deploy.py _invoke): flat kwargs. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const P='agentmigrations', L='us-east1', F=process.env.FLOW||'GetRateSheetBand';
const token = await getSaToken('admin@migrationn.com');
const url = `https://integrations.googleapis.com/v2/projects/${P}/locations/${L}/integrations/${F}:execute?triggerId=api_trigger/${F}_API_1`;
const val = Number(process.env.V ?? 5000000);
const r = await fetch(url, { method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'}, body: JSON.stringify({ NewLimit: val }) });
const t = await r.text();
const bands = [...new Set(t.match(/Limit Band Max\\":\\"(\d+)/g) ?? [])];
console.log(`flat {NewLimit:${val}} -> HTTP ${r.status}  rows=${(t.match(/Risk Rating/g)??[]).length}  bands=${bands.join(',') || '(none)'}`);
if (!r.ok) console.log(t.slice(0,300));
process.exit(0);
