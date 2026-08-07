/** Project NUMBERS for IAM grants. The id form yields `400 … does not exist` and the
 *  grant silently never applies (handoff.md §6), so never guess these.
 *  npx tsx src/spikes/_probe_project_numbers.ts */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
}).authorize();

for (const project of ['studio-enterprise-migration', 'gtm-project-504611']) {
  const res = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${project}`, {
    headers: { Authorization: `Bearer ${access_token!}` },
  });
  if (!res.ok) {
    console.log(`${project}: ${res.status} ${(await res.text()).slice(0, 120)}`);
    continue;
  }
  const j = (await res.json()) as { projectNumber?: string; name?: string };
  console.log(`${project}`);
  console.log(`  number : ${j.projectNumber}`);
  console.log(`  re SA  : service-${j.projectNumber}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`);
}
process.exit(0);
