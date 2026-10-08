/**
 * Is the service account authorized for gmail.modify in domain-wide delegation, for the
 * accounts we would migrate to Gmail? Mints a DWD token per subject and calls Gmail.
 *
 *   npx tsx src/spikes/_probe_gmail_dwd.ts
 *   WHO=admin@migrationn.com SCOPE=https://www.googleapis.com/auth/gmail.readonly npx tsx ...
 */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';

// mintSaToken is module-private; mint the same way it does (JWT + subject) so this probe
// exercises the REAL DWD grant rather than a wrapper's allowlist. Key location comes from
// the app's own validated config, never a hand-guessed path.
const raw = config.GOOGLE_SA_KEY_JSON
  ? config.GOOGLE_SA_KEY_JSON
  : readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const key = JSON.parse(raw) as { client_email: string; private_key: string; client_id?: string };
console.log(`service account: ${key.client_email}  client_id(for DWD): ${key.client_id ?? '(absent)'}`);
async function mintSaToken(scopes: string[], subject: string): Promise<string> {
  const c = new JWT({ email: key.client_email, key: key.private_key, scopes, subject });
  const { access_token } = await c.authorize();
  if (!access_token) throw new Error('no access token');
  return access_token;
}

const SCOPE = process.env.SCOPE || 'https://www.googleapis.com/auth/gmail.modify';
const WHO = (process.env.WHO || 'admin@migrationn.com,alex@migrationn.com').split(',').map((s) => s.trim());

console.log(`scope: ${SCOPE}\n`);
for (const who of WHO) {
  let token: string;
  try {
    token = await mintSaToken([SCOPE], who);
  } catch (e) {
    console.log(`${who.padEnd(26)} MINT FAILED: ${String((e as Error).message).slice(0, 220)}`);
    continue;
  }
  const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', {
    headers: { Authorization: `Bearer ${token}` },
  });
  const t = await r.text();
  if (r.ok) {
    const j = JSON.parse(t) as { emailAddress?: string; messagesTotal?: number };
    console.log(`${who.padEnd(26)} OK   mailbox=${j.emailAddress}  messages=${j.messagesTotal}`);
  } else {
    console.log(`${who.padEnd(26)} HTTP ${r.status}  ${t.replace(/\s+/g, ' ').slice(0, 220)}`);
  }
}
process.exit(0);
