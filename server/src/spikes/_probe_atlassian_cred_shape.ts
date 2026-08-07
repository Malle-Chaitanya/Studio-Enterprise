/** Is the stored Atlassian credential well-formed? Prints SHAPE only, never values. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { getEntraSecret } from '../services/secretManager.js';
const PROJECT = 'studio-enterprise-migration';
const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();
const get = async (id: string) => (await getEntraSecret(access_token!, `projects/${PROJECT}/secrets/${id}/versions/latest`)).plaintext!;
for (const id of ['studio-enterprise-atlassian-base-url', 'studio-enterprise-atlassian-email', 'studio-enterprise-atlassian-api-token']) {
  const v = await get(id);
  const t = v.trim();
  console.log(`${id}: length=${v.length} trimmed=${t.length} whitespaceEdges=${v !== t} newline=${/\r|\n/.test(v)}`);
}
const tok = (await get('studio-enterprise-atlassian-api-token')).trim();
console.log(`\ntoken shape: ${tok.startsWith('ATATT') ? 'current scoped token (ATATT…)' : tok.length < 40 ? `legacy/short (${tok.length} chars)` : `unrecognised (${tok.length} chars)`}`);
process.exit(0);
