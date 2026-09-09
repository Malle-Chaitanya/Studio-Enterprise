/** The Cloud SQL check just returned project number 231705905417 for "agentmigrations",
 *  but earlier session logs explicitly showed projectNumber: "505103737920" for the same
 *  project id string. Resolve the ACTUAL project number authoritatively via Resource
 *  Manager to find out which is right (or if there are two different projects involved).
 *  npx tsx src/spikes/_diag_resolve_agentmigrations_project.ts */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const saToken = await getSaToken();
const res = await fetch('https://cloudresourcemanager.googleapis.com/v1/projects/agentmigrations', {
  headers: { Authorization: `Bearer ${saToken}` },
});
console.log('status:', res.status);
console.log(await res.text());
process.exit(0);
