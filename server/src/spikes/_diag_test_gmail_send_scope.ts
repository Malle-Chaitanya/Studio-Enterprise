/** Live test: does the service account's Domain-Wide Delegation grant actually include
 *  gmail.modify (needed to SEND) for the identity our migration wired Gmail send to
 *  (admin@migrationn.com), or only gmail.readonly (which would explain "unauthorized" on
 *  send while reads work)? Creates a DRAFT (safe, reversible, never sends), then deletes it.
 *  npx tsx src/spikes/_diag_test_gmail_send_scope.ts */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';

const IMPERSONATE = 'admin@migrationn.com';
const SCOPE = 'https://www.googleapis.com/auth/gmail.modify';

function loadKey(): Record<string, unknown> {
  if (process.env.GOOGLE_SA_KEY_JSON) return JSON.parse(process.env.GOOGLE_SA_KEY_JSON);
  if (process.env.GOOGLE_SA_KEY_FILE) return JSON.parse(readFileSync(process.env.GOOGLE_SA_KEY_FILE, 'utf8'));
  throw new Error('No service account key configured.');
}

const key = loadKey();
console.log(`Minting a DWD token: scope=${SCOPE} subject=${IMPERSONATE}`);
const client = new JWT({
  email: key.client_email as string,
  key: key.private_key as string,
  scopes: [SCOPE],
  subject: IMPERSONATE,
});

let token: string | undefined;
try {
  const res = await client.authorize();
  token = res.access_token ?? undefined;
  console.log(`Token mint: OK (length ${token?.length ?? 0})`);
} catch (e) {
  console.log('Token mint FAILED — the DWD grant does not include this scope at all for this Client ID:');
  console.log(String((e as Error).message).slice(0, 800));
  process.exit(0);
}

console.log('\nAttempting to create a Gmail DRAFT (write-scope test, safe/reversible)...');
const mime = Buffer.from(
  `To: ${IMPERSONATE}\r\nSubject: CSGE scope-diagnostic (safe to delete)\r\n\r\nThis is a draft-only diagnostic. Never sent.`,
).toString('base64url');
const createRes = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
  method: 'POST',
  headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: { raw: mime } }),
});
console.log('Create draft status:', createRes.status);
const text = await createRes.text();
console.log(text.slice(0, 1500));

if (createRes.ok) {
  const json = JSON.parse(text) as { id?: string };
  if (json.id) {
    const delRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${json.id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    console.log(`\nCleaned up test draft: ${delRes.status === 204 ? 'deleted OK' : `delete status ${delRes.status}`}`);
  }
}
process.exit(0);
