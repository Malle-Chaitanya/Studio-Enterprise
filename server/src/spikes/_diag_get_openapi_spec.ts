/** Fetch the real OpenAPI spec for our published DraftFollowUpEmail integration, so we
 *  know the exact request schema (including typed input parameter format) to call it
 *  as a tool. Read-only. npx tsx src/spikes/_diag_get_openapi_spec.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const project = 'agentmigrations';
const location = 'us-east1';

const url = `https://${location}-integrations.googleapis.com/v1/projects/${project}/locations/${location}:generateOpenApiSpec`;
const body = {
  apiTriggerResources: [
    {
      integrationResource: 'DraftFollowUpEmail',
      triggerId: ['api_trigger/DraftFollowUpEmail_API_1'],
    },
  ],
  fileFormat: 'JSON',
};

const res = await fetch(url, {
  method: 'POST',
  headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});
console.log('Status:', res.status);
const text = await res.text();
console.log(text.slice(0, 6000));
process.exit(0);
