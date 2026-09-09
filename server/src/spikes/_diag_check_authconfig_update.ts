/** Does Application Integration support updating an EXISTING AuthConfig's credential
 *  (e.g. after a customer rotates their client secret), or only create-once? Checking
 *  before assuming either way. npx tsx src/spikes/_diag_check_authconfig_update.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';
const gToken = await getSaToken();

const listRes = await fetch(`https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/authConfigs`, {
  headers: { Authorization: `Bearer ${gToken}` },
});
const listJson = (await listRes.json()) as { authConfigs?: { name?: string; displayName?: string }[] };
const mine = (listJson.authConfigs ?? []).find((a) => a.displayName === 'ms_graph');
console.log('Found AuthConfig:', mine?.name);
if (!mine?.name) process.exit(0);

// Try a PATCH with a trivial, harmless change (description) using an updateMask.
const patchRes = await fetch(`https://${LOCATION}-integrations.googleapis.com/v1/${mine.name}?updateMask=description`, {
  method: 'PATCH',
  headers: { Authorization: `Bearer ${gToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ description: 'CSGE probe: confirming AuthConfig PATCH support.' }),
});
console.log('PATCH status:', patchRes.status);
console.log((await patchRes.text()).slice(0, 800));
process.exit(0);
