/**
 * Which Chat scope is missing from domain-wide delegation? One mint per scope.
 *
 * A combined request fails as a single `unauthorized_client` naming nothing, so adding four
 * scopes and getting one error tells you nothing about which. Minting them one at a time
 * turns that into a list — the trick that localised gmail.modify in seconds (ledger 1.45).
 *
 *   cd server && npx tsx src/spikes/_diag_chat_scopes.ts [subject]
 */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { readFileSync } from 'node:fs';

const SUBJECT = process.argv[2] || 'zara@storefuze.com';
const sa = JSON.parse(
  process.env.GOOGLE_SA_KEY_JSON || readFileSync(process.env.GOOGLE_SA_KEY_FILE || './service_account.json', 'utf8'),
) as { client_email: string; private_key: string; client_id?: string };

const SCOPES = [
  'https://www.googleapis.com/auth/chat.spaces',
  'https://www.googleapis.com/auth/chat.messages',
  'https://www.googleapis.com/auth/chat.spaces.create',
  'https://www.googleapis.com/auth/chat.memberships.readonly',
  'https://www.googleapis.com/auth/chat.memberships',
];

console.log(`client id : ${sa.client_id}`);
console.log(`subject   : ${SUBJECT}\n`);

const granted: string[] = [];
for (const scope of SCOPES) {
  const client = new JWT({ email: sa.client_email, key: sa.private_key, scopes: [scope], subject: SUBJECT });
  try {
    const r = await client.getAccessToken();
    if (r?.token) { granted.push(scope); console.log(`GRANTED  ${scope}`); }
    else console.log(`NO TOKEN ${scope}`);
  } catch (e) {
    const m = (e as Error).message.replace(/\s+/g, ' ');
    console.log(`MISSING  ${scope}\n         ${m.slice(0, 110)}`);
  }
}
console.log(`\n${granted.length}/${SCOPES.length} granted. Add the MISSING strings verbatim in`);
console.log('Workspace admin -> Security -> API controls -> Domain-wide delegation.');
process.exit(0);
