/** What Confluence spaces exist, and do the agent's source names match any? Read-only. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { getEntraSecret } from '../services/secretManager.js';

const PROJECT = 'studio-enterprise-migration';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();

const get = async (id: string) => {
  const r = await getEntraSecret(access_token!, `projects/${PROJECT}/secrets/${id}/versions/latest`);
  if (!r.ok) throw new Error(`${id}: ${r.error}`);
  return r.plaintext!;
};
const base = (await get('studio-enterprise-atlassian-base-url')).trim().replace(/\/$/, '');
const email = (await get('studio-enterprise-atlassian-email')).trim();
const token = (await get('studio-enterprise-atlassian-api-token')).trim();
console.log(`base_url: ${base}`);
console.log(`email   : ${email}\n`);

const auth = 'Basic ' + Buffer.from(`${email}:${token}`).toString('base64');
for (const type of ['global', 'personal']) {
  const url = `${base}/wiki/rest/api/space?limit=100&type=${type}`;
  const res = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!res.ok) { console.log(`${type}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`); continue; }
  const j = await res.json() as { results?: Array<{ key: string; name: string }> };
  console.log(`--- ${type} spaces (${j.results?.length ?? 0}) ---`);
  for (const s of j.results ?? []) console.log(`  ${s.key.padEnd(14)} ${s.name}`);
}
process.exit(0);
