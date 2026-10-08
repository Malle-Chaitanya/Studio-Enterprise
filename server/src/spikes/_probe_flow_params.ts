/** What input variables does the deployed integration actually declare? */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = process.env.FLOW_PROJECT || 'agentmigrations';
const LOCATION = 'us-east1';
const FLOW = process.env.FLOW || 'GetRateSheetBand';
const token = await getSaToken(process.env.SUBJECT || 'admin@migrationn.com');

const res = await fetch(
  `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/integrations/${FLOW}/versions?pageSize=5`,
  { headers: { Authorization: `Bearer ${token}` } },
);
const j = (await res.json()) as { integrationVersions?: any[] };
const v = (j.integrationVersions ?? [])[0];
if (!v) { console.log('no versions:', JSON.stringify(j).slice(0, 400)); process.exit(0); }
console.log(`version=${v.name?.split('/').pop()} state=${v.state}`);
for (const t of v.triggerConfigs ?? []) {
  console.log(`trigger ${t.triggerId}  inputVariables=${JSON.stringify(t.inputVariables)}`);
}
const js = (v.taskConfigs ?? []).find((t: any) => t.task === 'JavaScriptTask');
if (js) {
  const src = js.parameters?.script?.value?.stringValue ?? '';
  console.log('--- filter script ---');
  console.log(String(src).slice(0, 900));
}
process.exit(0);
