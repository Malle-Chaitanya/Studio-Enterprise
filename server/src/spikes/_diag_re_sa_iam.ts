/** Is the Reasoning Engine runtime service agent granted Discovery Engine read?
 *  adkDeployer builds the member from the project ID; Google uses the project NUMBER.
 *  npx tsx src/spikes/_diag_re_sa_iam.ts */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const P = process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const h = { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' };
const pn = await (await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${P}`, { headers: h })).json() as { projectNumber?: string };
console.log(`projectNumber: ${pn.projectNumber}`);
const r = await fetch(`https://cloudresourcemanager.googleapis.com/v1/projects/${P}:getIamPolicy`, { method: 'POST', headers: h, body: '{}' });
const pol = await r.json() as { bindings?: Array<{ role: string; members: string[] }> };
const want = `serviceAccount:service-${pn.projectNumber}@gcp-sa-aiplatform-re.iam.gserviceaccount.com`;
console.log(`looking for: ${want}\n`);
for (const b of pol.bindings ?? []) {
  const hits = b.members.filter(m => /aiplatform-re|discoveryengine/i.test(m));
  if (hits.length) console.log(`${b.role}\n  ${hits.join('\n  ')}`);
}
const has = (pol.bindings ?? []).some(b => b.role === 'roles/discoveryengine.viewer' && b.members.includes(want));
console.log(`\nRE service agent has roles/discoveryengine.viewer: ${has ? 'YES' : 'NO'}`);
