/** What service account does the real, deployed Deal Desk Reasoning Engine actually
 *  run as -- a default Google-managed agent, or an explicit existing SA from the
 *  project's own IAM list? Read-only.
 *  npx tsx src/spikes/_diag_reasoning_engine_identity.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const url = 'https://us-central1-aiplatform.googleapis.com/v1/projects/505103737920/locations/us-central1/reasoningEngines/8492880150860398592';
const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
console.log('Status:', res.status);
console.log(await res.text());
process.exit(0);
