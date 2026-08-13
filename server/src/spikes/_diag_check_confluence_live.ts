/** Confluence live check using the stored connectorCredentials secret ids (shared_confluence). Read-only. */
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
const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
console.log(`base=${base}  email=${email}\n`);

const paths = [
  '/wiki/rest/api/user/current',
  '/wiki/rest/api/space?limit=5&status=current',
];
for (const p of paths) {
  try {
    const r = await fetch(`${base}${p}`, { headers: { Authorization: auth, Accept: 'application/json' } });
    const body = await r.text();
    console.log(`${r.status}  ${p}`);
    console.log(`      ${body.replace(/\s+/g, ' ').slice(0, 250)}`);
  } catch (e) { console.log(`ERR  ${p}  ${(e as Error).message}`); }
}
process.exit(0);
