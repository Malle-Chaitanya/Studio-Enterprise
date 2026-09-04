/** Does a OneDrive (or any Microsoft) connection/auth profile already exist in
 *  agentmigrations, via either Integration Connectors' "connections" API or
 *  Application Integration's own "authConfigs" API? Read-only.
 *  npx tsx src/spikes/_diag_check_onedrive_connection.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';

console.log('--- Integration Connectors: connections ---');
const connRes = await fetch(
  `https://connectors.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/connections`,
  { headers: { Authorization: `Bearer ${saToken}` } },
);
console.log('Status:', connRes.status);
console.log((await connRes.text()).slice(0, 2000));

console.log('\n--- Application Integration: authConfigs ---');
const authRes = await fetch(
  `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/authConfigs`,
  { headers: { Authorization: `Bearer ${saToken}` } },
);
console.log('Status:', authRes.status);
console.log((await authRes.text()).slice(0, 2000));
process.exit(0);
