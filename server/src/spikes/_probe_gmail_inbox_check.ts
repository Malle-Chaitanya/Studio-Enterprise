/** Read each mailbox as ITSELF and show the newest message's From — proves the send landed
 *  and that the sender identity really was the caller, not a shared account. */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const raw = config.GOOGLE_SA_KEY_JSON || readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const key = JSON.parse(raw) as { client_email: string; private_key: string };
for (const who of (process.env.WHO || 'admin@migrationn.com,alex@migrationn.com').split(',')) {
  const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE], subject: who.trim() });
  const { access_token: t } = await jwt.authorize();
  const l = await (await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=2&q=in:inbox', { headers: { Authorization: `Bearer ${t}` } })).json() as any;
  const ids = (l.messages ?? []).map((m: any) => m.id);
  console.log(`${who.trim().padEnd(24)} inbox messages=${ids.length}`);
  for (const id of ids) {
    const m = await (await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject`, { headers: { Authorization: `Bearer ${t}` } })).json() as any;
    const h = Object.fromEntries((m.payload?.headers ?? []).map((x: any) => [x.name.toLowerCase(), x.value]));
    console.log(`    From: ${h.from}   Subject: ${h.subject}`);
  }
}
process.exit(0);
