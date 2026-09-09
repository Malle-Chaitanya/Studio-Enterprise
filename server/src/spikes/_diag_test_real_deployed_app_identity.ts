/** Mint a token using the ACTUAL stored credential the deployed agent's connector tool
 *  uses (client_id 0cc5ee2a..., a DIFFERENT Entra app than MS_CLIENT_ID which my earlier
 *  reproduction used), then retry the exact cr88d_clientcreditfacilities query, both
 *  plain and impersonating erik@filefuze.co, to see if THIS app hits the real 403.
 *  npx tsx src/spikes/_diag_test_real_deployed_app_identity.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const PROJECT = 'agentmigrations';
const APP_USER_ID = '6a5dfdff7cf05623332758b7';

async function readSecret(name: string): Promise<string> {
  const secretId = `studio-enterprise-${APP_USER_ID}-${name}`;
  const url = `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  const json = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(json.payload?.data ?? '', 'base64').toString('utf8');
}

const tenantId = await readSecret('ms-graph-tenant-id');
const clientId = await readSecret('ms-graph-client-id');
const clientSecret = await readSecret('ms-graph-client-secret');
console.log('Using client_id:', clientId);

const orgUrl = 'https://org32322095.crm.dynamics.com';
const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: `${orgUrl}/.default`,
  }),
});
const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
console.log('Token mint status:', tokenRes.status);
if (!tokenJson.access_token) {
  console.log('FAILED TO MINT TOKEN:', JSON.stringify(tokenJson).slice(0, 500));
  process.exit(0);
}
console.log('Token minted OK.');

const base = `${orgUrl}/api/data/v9.2`;

console.log('\n--- Plain query (this app, no impersonation) ---');
const plainRes = await fetch(`${base}/cr88d_clientcreditfacilities?$top=1`, {
  headers: { Authorization: `Bearer ${tokenJson.access_token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' },
});
console.log('status:', plainRes.status);
console.log((await plainRes.text()).slice(0, 800));

console.log('\n--- Impersonated query (MSCRMCallerID = erik@filefuze.co) ---');
const impRes = await fetch(`${base}/cr88d_clientcreditfacilities?$top=1`, {
  headers: {
    Authorization: `Bearer ${tokenJson.access_token}`,
    Accept: 'application/json',
    'OData-MaxVersion': '4.0',
    'OData-Version': '4.0',
    MSCRMCallerID: 'bc5e0f98-2619-f111-8341-6045bd07e2cb',
  },
});
console.log('status:', impRes.status);
console.log((await impRes.text()).slice(0, 800));
process.exit(0);
