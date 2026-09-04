/** Can we create an Application Integration Auth Profile (authConfig) via API, using
 *  the already-known-working Microsoft Graph client_credentials? Tests whether
 *  integrationEditor already covers this, before assuming another IAM grant is needed.
 *  npx tsx src/spikes/_diag_test_authconfig_create.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const PROJECT = 'agentmigrations';
const LOCATION = 'us-east1';

// Minimal probe: try creating an OAuth2 client-credentials authConfig.
const body = {
  displayName: 'ms-graph-onedrive-test',
  description: 'Test auth profile for OneDrive/MS Graph access (client_credentials)',
  oauth2ClientCredentials: {
    clientId: 'PLACEHOLDER_WILL_NOT_ACTUALLY_SUBMIT_REAL_SECRET_HERE',
    clientSecret: { plainText: 'placeholder' },
    tokenEndpoint: 'https://login.microsoftonline.com/PLACEHOLDER/oauth2/v2.0/token',
    requestType: 'REQUEST_BODY',
  },
};

const res = await fetch(
  `https://${LOCATION}-integrations.googleapis.com/v1/projects/${PROJECT}/locations/${LOCATION}/authConfigs`,
  { method: 'POST', headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
);
console.log('Status:', res.status);
console.log((await res.text()).slice(0, 1500));
process.exit(0);
