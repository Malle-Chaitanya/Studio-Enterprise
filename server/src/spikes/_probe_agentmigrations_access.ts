/** What can our SA actually do on the project this session picked? */
import { getSaToken } from '../auth/google.js';
const P = 'agentmigrations';
const t = await getSaToken();
const checks: Array<[string, string]> = [
  ['list engines', `https://discoveryengine.googleapis.com/v1alpha/projects/${P}/locations/global/collections/default_collection/engines`],
  ['list secrets', `https://secretmanager.googleapis.com/v1/projects/${P}/secrets`],
  ['list reasoning engines', `https://us-central1-aiplatform.googleapis.com/v1beta1/projects/${P}/locations/us-central1/reasoningEngines`],
];
for (const [label, url] of checks) {
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
    const b = await r.text();
    console.log(`${label}: ${r.status}` + (r.ok ? '' : ` -> ${b.slice(0, 110).replace(/\s+/g, ' ')}`));
  } catch (e) { console.log(`${label}: ERROR ${(e as Error).message.slice(0, 80)}`); }
}
