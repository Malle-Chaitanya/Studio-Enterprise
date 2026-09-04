/** Create a real Application Integration Auth Profile (authConfig) for Microsoft
 *  Graph client_credentials, using the already-proven-working real credentials.
 *  Never logs the secret value. npx tsx src/spikes/_diag_create_msgraph_authconfig.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const SECRET_PROJECT = 'studio-enterprise-migration';
const gcpToken = await getSaToken();

async function readSecret(secretId: string): Promise<string> {
  const url = `https://secretmanager.googleapis.com/v1/projects/${SECRET_PROJECT}/secrets/${secretId}/versions/latest:access`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${gcpToken}` } });
  const json = (await res.json()) as { payload?: { data?: string } };
  return Buffer.from(json.payload!.data!, 'base64').toString('utf-8');
}

const tenantId = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-tenant-id');
const clientId = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-client-id');
const clientSecret = await readSecret('studio-enterprise-6a5dfdff7cf05623332758b7-ms-graph-client-secret');

const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';

const body = {
  displayName: 'ms-graph-onedrive',
  description: 'Microsoft Graph client_credentials auth, reused from existing Deal Desk migration credentials.',
  decryptedCredential: {
    credentialType: 'OAUTH2_CLIENT_CREDENTIALS',
    oauth2ClientCredentials: {
      clientId,
      clientSecret,
      tokenEndpoint: `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
      scope: 'https://graph.microsoft.com/.default',
      requestType: 'REQUEST_BODY',
    },
  },
};

const res = await fetch(
  `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/authConfigs`,
  { method: 'POST', headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
);
console.log('Status:', res.status);
const text = await res.text();
// Redact any secret-looking value before printing, defense in depth.
console.log(text.replace(new RegExp(clientSecret, 'g'), '[REDACTED]'));
process.exit(0);
