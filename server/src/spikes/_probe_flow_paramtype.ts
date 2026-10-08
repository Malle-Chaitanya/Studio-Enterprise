/** Declared type of the flow's input variable, + does the agent's own dataType survive? */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
const P = process.env.FLOW_PROJECT || 'agentmigrations', L = 'us-east1';
const F = process.env.FLOW || 'GetRateSheetBand';
const token = await getSaToken(process.env.SUBJECT || 'admin@migrationn.com');
const r = await fetch(`https://${L}-integrations.googleapis.com/v1/projects/${P}/locations/${L}/integrations/${F}/versions?pageSize=1`, { headers: { Authorization: `Bearer ${token}` } });
const v = ((await r.json()) as any).integrationVersions?.[0];
for (const p of v?.integrationParameters ?? []) {
  if (!/^`?(CloudFunction|Integration)/.test(p.key)) console.log(`${String(p.key).padEnd(38)} type=${p.dataType} inOut=${p.inputOutputType} default=${JSON.stringify(p.defaultValue ?? null)}`);
}
process.exit(0);
