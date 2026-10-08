/**
 * WHY: the deployed agent authenticates with the CONNECTOR CREDENTIAL's service account,
 * NOT the app's own SA — so _probe_gmail_dwd.ts (which reads config.GOOGLE_SA_KEY_*) can
 * report a healthy grant while the container gets `unauthorized_client`. This probe reads
 * the key the container actually receives, out of the destination project, and mints with it.
 *
 *   npx tsx src/spikes/_probe_gmail_runtime_auth.ts
 *   PROJECT=agentmigrations WHO=admin@migrationn.com npx tsx src/spikes/_probe_gmail_runtime_auth.ts
 *
 * NEVER prints the private key — only the identity fields needed to fix a DWD grant.
 */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

const PROJECT = process.env.PROJECT || 'agentmigrations';
const WHO = (process.env.WHO || 'admin@migrationn.com,alex@migrationn.com').split(',').map((s) => s.trim());
const SCOPES = (process.env.SCOPES || 'https://www.googleapis.com/auth/gmail.modify').split(',');

const saToken = await getSaToken();

// Find the secret the gmail connector reads, by listing rather than guessing the name.
const lr = await fetch(
  `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets?pageSize=200`,
  { headers: { Authorization: `Bearer ${saToken}` } },
);
const lt = await lr.text();
if (!lr.ok) {
  console.log(`list secrets in ${PROJECT}: HTTP ${lr.status} ${lt.replace(/\s+/g, ' ').slice(0, 300)}`);
  process.exit(1);
}
const names = ((JSON.parse(lt) as { secrets?: { name: string }[] }).secrets ?? [])
  .map((s) => s.name.split('/').pop()!)
  .filter((n) => /gmail|google.*service-account|service-account.*google/i.test(n));
console.log(`candidate secrets in ${PROJECT}:`);
names.forEach((n) => console.log(`  ${n}`));
if (!names.length) {
  console.log('\nNo Gmail/Google service-account secret in this project — the container has no key to use.');
  process.exit(0);
}

for (const id of names) {
  const r = await getEntraSecret(saToken, `projects/${PROJECT}/secrets/${id}/versions/latest`);
  if (!r.ok || !r.plaintext) {
    console.log(`\n${id}\n  UNREADABLE ${String((r as { error?: string }).error).replace(/\s+/g, ' ').slice(0, 160)}`);
    continue;
  }
  let key: { client_email?: string; client_id?: string; private_key?: string; private_key_id?: string };
  try {
    key = JSON.parse(r.plaintext) as typeof key;
  } catch {
    console.log(`\n${id}\n  not a service-account JSON (${r.plaintext.length} chars) — probably an impersonate_email or token field`);
    continue;
  }
  console.log(`\n${id}`);
  console.log(`  client_email : ${key.client_email ?? '(absent)'}`);
  console.log(`  client_id    : ${key.client_id ?? '(absent)'}   <- this is what DWD authorizes`);
  console.log(`  key id       : ${(key.private_key_id ?? '').slice(0, 8)}…`);
  if (!key.client_email || !key.private_key) continue;

  for (const who of WHO) {
    let token: string;
    try {
      const c = new JWT({ email: key.client_email, key: key.private_key, scopes: SCOPES, subject: who });
      token = (await c.authorize()).access_token ?? '';
      if (!token) throw new Error('no access token');
    } catch (e) {
      console.log(`  ${who.padEnd(24)} MINT FAILED  ${String((e as Error).message).replace(/\s+/g, ' ').slice(0, 200)}`);
      continue;
    }
    const p = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const pt = await p.text();
    console.log(
      p.ok
        ? `  ${who.padEnd(24)} OK  mailbox=${(JSON.parse(pt) as { emailAddress?: string }).emailAddress}`
        : `  ${who.padEnd(24)} HTTP ${p.status}  ${pt.replace(/\s+/g, ' ').slice(0, 200)}`,
    );
  }
}
process.exit(0);
