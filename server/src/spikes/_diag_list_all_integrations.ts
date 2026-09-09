/** List every real Application Integration this session created, so we know exactly
 *  what exists before deleting anything. Read-only.
 *  npx tsx src/spikes/_diag_list_all_integrations.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';
const saToken = await getSaToken();

const res = await fetch(`https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/integrations`, {
  headers: { Authorization: `Bearer ${saToken}` },
});
console.log('status:', res.status);
const json = (await res.json()) as { integrations?: { name?: string; updateTime?: string; description?: string }[] };
for (const i of json.integrations ?? []) {
  console.log(`  ${i.name?.split('/').pop()}  (updated ${i.updateTime})`);
}
process.exit(0);
