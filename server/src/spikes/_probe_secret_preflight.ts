/** Does the credential-save preflight name the REAL cause?
 *
 *  Saving connector credentials into a project our SA cannot write to used to fail on
 *  the write, half-way through the loop, and the UI reported "Check that Google is
 *  connected" — which was never the problem. This checks the preflight separates the
 *  two projects we know differ (handoff.md §6):
 *    studio-enterprise-migration  our SA can write        -> ok
 *    gtm-project-504611           no Secret Manager rights -> access denied + the grant
 *
 *  npx tsx src/spikes/_probe_secret_preflight.ts
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { preflightSecretAccess } from '../services/secretManager.js';

const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({
  email: k.client_email,
  key: k.private_key,
  scopes: ['https://www.googleapis.com/auth/cloud-platform'],
}).authorize();

console.log(`SA: ${k.client_email}\n`);

for (const [label, project] of [
  ['target project (expect ok)', 'studio-enterprise-migration'],
  ['GTM project (expect denied)', 'gtm-project-504611'],
  ['nonexistent project (expect not found)', 'cf-no-such-project-42a9'],
] as const) {
  const r = await preflightSecretAccess(project, access_token!, k.client_email);
  console.log(label);
  console.log(`  project : ${project}`);
  console.log(`  ok      : ${r.ok}`);
  console.log(`  code    : ${r.code ?? '-'}`);
  console.log(`  detail  : ${r.detail ?? '-'}\n`);
}
process.exit(0);
