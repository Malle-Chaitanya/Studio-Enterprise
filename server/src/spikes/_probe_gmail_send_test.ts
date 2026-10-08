/**
 * Send a real Gmail message through the SAME path a migrated agent uses: a DWD token whose
 * subject is the CALLER. Proves gmail.modify write works and that the mail is sent AS that
 * person, not from a shared account.
 *
 * Recipients are internal test accounts only.
 *   FROM=alex@migrationn.com TO=admin@migrationn.com npx tsx src/spikes/_probe_gmail_send_test.ts
 */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { readFileSync } from 'node:fs';
import { config } from '../config.js';

const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';
const FROM = process.env.FROM || 'alex@migrationn.com';
const TO = process.env.TO || 'admin@migrationn.com';
const SUBJECT = process.env.SUBJECT_LINE || 'CS_GE per-caller Gmail send test';

// `??` is wrong here: GOOGLE_SA_KEY_JSON is present but EMPTY in this env, and an empty
// string is not nullish -- it reached JSON.parse and failed. Truthiness, not nullish.
const raw = config.GOOGLE_SA_KEY_JSON || readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8');
const key = JSON.parse(raw) as { client_email: string; private_key: string };
const jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE], subject: FROM });
const { access_token: token } = await jwt.authorize();

// Same MIME shape connector_tools/gmail.py builds, base64url without padding.
const mime = [`To: ${TO}`, `Subject: ${SUBJECT}`, 'Content-Type: text/plain; charset="UTF-8"', '',
  `Sent by the CS_GE Gmail connector probe as ${FROM}. If the From address on this message is ` +
  `${FROM}, the per-caller DWD subject swap works.`].join('\r\n');
const encoded = Buffer.from(mime, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ raw: encoded }),
});
const body = await r.text();
console.log(`send as ${FROM} -> ${TO}: HTTP ${r.status} ${body.replace(/\s+/g, ' ').slice(0, 200)}`);
process.exit(0);
