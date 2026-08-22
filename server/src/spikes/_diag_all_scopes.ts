/**
 * Probe EVERY scope the product needs, one at a time, so a failure names itself.
 *
 * A DWD grant is exact-string matched and the console replaces the whole list on save, so
 * the two realistic failure modes are (a) the save landed on a different client id / entry,
 * and (b) one scope string is missing or mistyped. Testing each scope separately tells those
 * apart: if the NEW ones pass and one fails, it is (b); if every new one fails, it is (a).
 *
 *   cd server && npx tsx src/spikes/_diag_all_scopes.ts [subject]
 */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { readFileSync } from 'node:fs';

const SUBJECT = process.argv[2] || 'zara@storefuze.com';
const sa = JSON.parse(
  readFileSync(process.env.GOOGLE_SA_KEY_FILE || './service_account.json', 'utf8'),
) as { client_email: string; private_key: string; client_id?: string };

const SCOPES: Array<[string, string]> = [
  ['gmail.modify', 'https://www.googleapis.com/auth/gmail.modify'],
  ['gmail.readonly', 'https://www.googleapis.com/auth/gmail.readonly'],
  ['drive', 'https://www.googleapis.com/auth/drive'],
  ['drive.readonly', 'https://www.googleapis.com/auth/drive.readonly'],
  ['admin.directory.user.readonly', 'https://www.googleapis.com/auth/admin.directory.user.readonly'],
  ['admin.directory.group.readonly', 'https://www.googleapis.com/auth/admin.directory.group.readonly'],
  ['admin.directory.domain.readonly', 'https://www.googleapis.com/auth/admin.directory.domain.readonly'],
  ['calendar', 'https://www.googleapis.com/auth/calendar'],
  ['contacts', 'https://www.googleapis.com/auth/contacts'],
  ['chat.spaces', 'https://www.googleapis.com/auth/chat.spaces'],
  ['chat.messages', 'https://www.googleapis.com/auth/chat.messages'],
];

console.log(`client id : ${sa.client_id}   <-- the entry that must carry these`);
console.log(`subject   : ${SUBJECT}\n`);

let ok = 0;
for (const [label, scope] of SCOPES) {
  let pass = false;
  let err = '';
  try {
    const r = await new JWT({ email: sa.client_email, key: sa.private_key, scopes: [scope], subject: SUBJECT })
      .getAccessToken();
    pass = Boolean(r?.token);
  } catch (e) {
    err = (e as Error).message.includes('unauthorized_client') ? 'not granted' : (e as Error).message.slice(0, 90);
  }
  if (pass) ok++;
  console.log(`${pass ? 'PASS' : 'FAIL'}  ${label.padEnd(34)}${pass ? '' : err}`);
}

console.log(`\n${ok}/${SCOPES.length} granted`);
if (ok <= 3) {
  console.log('\nMostly failing -> the save probably landed on a DIFFERENT client id, or on the');
  console.log('OAuth-consent screen instead of Domain-wide delegation. Check the entry is for');
  console.log(`client id ${sa.client_id} under Security > Access and data control > API controls.`);
}
process.exit(0);
