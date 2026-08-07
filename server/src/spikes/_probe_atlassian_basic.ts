/** Plain Basic-auth check with the stored email + token. Shape only, no secrets. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { getEntraSecret } from '../services/secretManager.js';
const PROJECT = 'studio-enterprise-migration';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const get = async (id: string) => (await getEntraSecret(access_token!, `projects/${PROJECT}/secrets/${id}/versions/latest`)).plaintext!.trim();
const base = (await get('studio-enterprise-atlassian-base-url')).replace(/\/$/, '');
const email = await get('studio-enterprise-atlassian-email');
const token = await get('studio-enterprise-atlassian-api-token');

console.log(`site : ${base}`);
console.log(`email: ${email}`);
console.log(`auth : Basic base64(email:token)   token length ${token.length}\n`);

const tries: Array<[string, Record<string, string>]> = [
  ['Basic email:token', { Authorization: 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64') }],
  ['Bearer token (in case it is an OAuth token)', { Authorization: `Bearer ${token}` }],
];
for (const [label, headers] of tries) {
  const r = await fetch(`${base}/rest/api/3/myself`, { headers: { ...headers, Accept: 'application/json' } });
  const body = (await r.text()).replace(/\s+/g, ' ').slice(0, 160);
  console.log(`${label}\n   /rest/api/3/myself -> ${r.status}  ${body}`);
}
// Does the token work against Atlassian's OAuth resource endpoint instead?
const ar = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
});
console.log(`\naccessible-resources (Bearer) -> ${ar.status}  ${(await ar.text()).replace(/\s+/g, ' ').slice(0, 200)}`);
process.exit(0);
