/** Can the behavioral gate run as the identity the CONNECTOR uses? Counts only, no content. */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';
const key = JSON.parse(config.GOOGLE_SA_KEY_JSON || readFileSync(config.GOOGLE_SA_KEY_FILE!, 'utf8'));
const CHECKS = [
  ['drive',    'https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/drive/v3/files?pageSize=5&fields=files(id)'],
  ['calendar', 'https://www.googleapis.com/auth/calendar',       'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=5'],
  ['contacts', 'https://www.googleapis.com/auth/contacts',       'https://people.googleapis.com/v1/people/me/connections?personFields=names&pageSize=5'],
] as const;
for (const subject of (process.env.CSGE_SUBJECTS ?? '').split(',').filter(Boolean)) {
  for (const [label, scope, url] of CHECKS) {
    try {
      const c = new JWT({ email: key.client_email, key: key.private_key, scopes: [scope], subject });
      const { access_token: t } = await c.authorize();
      const r = await fetch(url, { headers: { Authorization: `Bearer ${t}` } });
      const j: any = await r.json();
      const n = (j.files ?? j.items ?? j.connections ?? []).length;
      console.log(`${subject.padEnd(22)} ${label.padEnd(10)} HTTP ${r.status}  ${n} item(s)`);
    } catch (e) {
      console.log(`${subject.padEnd(22)} ${label.padEnd(10)} FAIL ${(e as Error).message.split('\n')[0].slice(0,46)}`);
    }
  }
}
