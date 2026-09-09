/** Check whether the Dataverse credential secrets actually exist and are correct in the
 *  "agentmigrations" project (where the deployed agent's container actually runs and reads
 *  secrets from) vs the older project they were copied FROM. The deploy log showed a wave
 *  of 401s reading these exact secret names during the copy step — if the copy silently
 *  failed, the deployed container could be minting a token from missing/stale/wrong values.
 *  npx tsx src/spikes/_diag_check_agentmigrations_dv_secrets.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const APP_USER_ID = '6a5dfdff7cf05623332758b7';
const OLD_PROJECT = '505103737920';
const NEW_PROJECT = 'agentmigrations';

const NAMES = ['ms-graph-tenant-id', 'ms-graph-client-id', 'ms-graph-client-secret'];

async function checkSecret(project: string, secretId: string) {
  const url = `https://secretmanager.googleapis.com/v1/projects/${project}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    return { ok: false, status: res.status, detail: text.slice(0, 200) };
  }
  const json = (await res.json()) as { payload?: { data?: string } };
  const plaintext = Buffer.from(json.payload?.data ?? '', 'base64').toString('utf8');
  return { ok: true, status: res.status, valuePreview: plaintext.slice(0, 8) + '...' + `(len=${plaintext.length})` };
}

for (const name of NAMES) {
  const secretId = `studio-enterprise-${APP_USER_ID}-${name}`;
  console.log(`\n=== ${name} ===`);
  console.log(`  OLD project (${OLD_PROJECT}):`, JSON.stringify(await checkSecret(OLD_PROJECT, secretId)));
  console.log(`  NEW project (${NEW_PROJECT}):`, JSON.stringify(await checkSecret(NEW_PROJECT, secretId)));
}
process.exit(0);
