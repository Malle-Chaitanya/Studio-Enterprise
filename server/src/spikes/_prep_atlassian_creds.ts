/** Store Confluence/Jira credentials the way the UI now does — under the shared
 *  `atlassian` credential group, so both connectors resolve them.
 *  npx tsx src/spikes/_prep_atlassian_creds.ts [project] */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
import { upsertSecret } from '../services/secretManager.js';
import { connectorSecretId, connectorCredentialFields } from '../services/connectorCredentials.js';

const PROJECT = process.argv[2] ?? process.env.E2E_PROJECT ?? 'studio-enterprise-migration';
const values: Record<string, string> = {
  base_url: process.env.CONFLUENCE_BASE_URL ?? '',
  email: process.env.CONFLUENCE_EMAIL ?? '',
  api_token: process.env.CONFLUENCE_TOKEN ?? '',
};
if (!values.base_url || !values.email || !values.api_token) {
  console.error('CONFLUENCE_BASE_URL / CONFLUENCE_EMAIL / CONFLUENCE_TOKEN required in server/.env');
  process.exit(1);
}

const raw = config.GOOGLE_SA_KEY_JSON?.trim() ? config.GOOGLE_SA_KEY_JSON : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const k = JSON.parse(raw) as { client_email: string; private_key: string };
const { access_token } = await new JWT({ email: k.client_email, key: k.private_key, scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).authorize();

for (const f of connectorCredentialFields('shared_confluence')) {
  const secretId = connectorSecretId('shared_confluence', f.key);
  const value = values[f.key];
  if (!value) { console.log(`  ${secretId}: no value, skipped`); continue; }
  await upsertSecret(access_token!, PROJECT, secretId, value);
  console.log(`  ${secretId} ✔ (shared=${f.shared})`); // value never printed
}
console.log('\nJira would reuse the same secrets:', connectorCredentialFields('shared_jira').map((f) => connectorSecretId('shared_jira', f.key)).join(', '));
process.exit(0);
