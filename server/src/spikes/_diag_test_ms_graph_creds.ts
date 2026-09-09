/** Do the already-stored shared_onedrive credentials (from a prior real setup) still
 *  work? Resolve from Secret Manager, mint a real MS Graph token, confirm live access.
 *  NEVER logs the actual secret/token values -- only success/failure and non-secret
 *  metadata. npx tsx src/spikes/_diag_test_ms_graph_creds.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SECRET_PROJECT = 'studio-enterprise-migration'; // CloudFuze's own project, per connectorCredentials.ts doc
const saToken = await getSaToken();

async function readSecret(secretId: string): Promise<string | null> {
  const url = `https://secretmanager.googleapis.com/v1/projects/${SECRET_PROJECT}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!res.ok) {
    console.log(`  readSecret(${secretId}) failed: ${res.status}`);
    return null;
  }
  const json = (await res.json()) as { payload?: { data?: string } };
  if (!json.payload?.data) return null;
  return Buffer.from(json.payload.data, 'base64').toString('utf-8');
}

const tenantId = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-tenant-id');
const clientId = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-client-id');
const clientSecret = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-client-secret');

console.log('tenant_id resolved:', !!tenantId, tenantId ? `(length ${tenantId.length})` : '');
console.log('client_id resolved:', !!clientId, clientId ? `(length ${clientId.length})` : '');
console.log('client_secret resolved:', !!clientSecret, clientSecret ? `(length ${clientSecret.length})` : '');

if (!tenantId || !clientId || !clientSecret) {
  console.log('\nCannot proceed to token mint -- one or more secrets unresolved.');
  process.exit(0);
}

const tokenRes = await fetch(`https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'https://graph.microsoft.com/.default',
  }),
});
console.log('\nMS token mint status:', tokenRes.status);
const tokenJson = (await tokenRes.json()) as { access_token?: string; error?: string; error_description?: string };
if (!tokenJson.access_token) {
  console.log('Token mint failed:', tokenJson.error, tokenJson.error_description);
  process.exit(0);
}
console.log('MS Graph token minted successfully (not printing the value).');

// Confirm live access: search OneDrive (app-only, admin's default drive) for the file.
const searchRes = await fetch(
  `https://graph.microsoft.com/v1.0/users/${'admin@migrationn.com'}/drive/root/search(q='deal desk demo sheet')`,
  { headers: { Authorization: `Bearer ${tokenJson.access_token}` } },
);
console.log('\nOneDrive search status:', searchRes.status);
console.log((await searchRes.text()).slice(0, 1500));
process.exit(0);
