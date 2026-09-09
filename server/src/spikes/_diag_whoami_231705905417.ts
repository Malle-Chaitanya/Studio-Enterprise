/** What IS project 231705905417 — the one the Cloud SQL Admin API error referenced,
 *  instead of agentmigrations (505103737920)? npx tsx src/spikes/_diag_whoami_231705905417.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const res = await fetch('https://cloudresourcemanager.googleapis.com/v1/projects/231705905417', {
  headers: { Authorization: `Bearer ${saToken}` },
});
console.log('status:', res.status);
console.log(await res.text());

// Also: what project does a totally generic, path-less call resolve to, if any implicit
// default is being applied by google-auth-library / ADC underneath getSaToken()?
console.log('\n--- GOOGLE_APPLICATION_CREDENTIALS / ADC env hints ---');
console.log('GOOGLE_APPLICATION_CREDENTIALS:', process.env.GOOGLE_APPLICATION_CREDENTIALS);
console.log('GOOGLE_CLOUD_PROJECT:', process.env.GOOGLE_CLOUD_PROJECT);
console.log('GCLOUD_PROJECT:', process.env.GCLOUD_PROJECT);
process.exit(0);
