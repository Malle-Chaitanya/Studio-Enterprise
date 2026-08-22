/**
 * Is `gmail.modify` granted? Every Gmail WRITE tool depends on it.
 *
 * The read tools work on `gmail.readonly`. Drafts, labels, star, read-state, trash and send
 * all need `gmail.modify`. If the Workspace DWD grant lists only readonly, the write tools
 * fail at token-mint time while the read tools keep working — an agent that is half broken
 * in a way that looks like a code bug.
 *
 *   cd server && npx tsx src/spikes/_diag_gmail_modify_scope.ts [subject]
 */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { readFileSync } from 'node:fs';

const SUBJECT = process.argv[2] || 'zara@storefuze.com';
const sa = JSON.parse(
  readFileSync(process.env.GOOGLE_SA_KEY_FILE || './service_account.json', 'utf8'),
) as { client_email: string; private_key: string; client_id?: string };

async function probe(scope: string): Promise<{ ok: boolean; err?: string; token?: string }> {
  try {
    const r = await new JWT({
      email: sa.client_email, key: sa.private_key, scopes: [scope], subject: SUBJECT,
    }).getAccessToken();
    return r?.token ? { ok: true, token: r.token } : { ok: false, err: 'no token' };
  } catch (e) {
    return { ok: false, err: (e as Error).message.replace(/\s+/g, ' ').slice(0, 150) };
  }
}

console.log(`client id : ${sa.client_id}`);
console.log(`subject   : ${SUBJECT}\n`);

for (const s of [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/gmail.send',
]) {
  const r = await probe(s);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${s.split('/auth/')[1]}${r.ok ? '' : `  (${r.err})`}`);
}

// A granted scope is not the same as a working write. Prove one real, REVERSIBLE write:
// create a draft and delete it again. Never sends anything.
const mod = await probe('https://www.googleapis.com/auth/gmail.modify');
if (mod.ok && mod.token) {
  const raw = Buffer.from(
    'To: nobody@example.invalid\r\nSubject: CS_GE scope probe\r\n\r\nSafe to delete.',
  ).toString('base64url');
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/drafts', {
    method: 'POST',
    headers: { Authorization: `Bearer ${mod.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: { raw } }),
  });
  const body = await res.text();
  if (res.ok) {
    const id = (JSON.parse(body) as { id?: string }).id;
    console.log(`\nPASS  real write: draft ${id} created`);
    const del = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${id}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${mod.token}` },
    });
    console.log(`${del.ok ? 'PASS' : 'WARN'}  cleanup: draft deleted (${del.status})`);
  } else {
    console.log(`\nFAIL  real write: ${res.status} ${(/"message":\s*"([^"]+)"/.exec(body)?.[1] ?? body.slice(0, 160))}`);
  }
} else {
  console.log('\nSKIP  real write — gmail.modify not granted.');
  console.log('      Add this scope to the SAME domain-wide delegation entry:');
  console.log('        https://www.googleapis.com/auth/gmail.modify');
  console.log('      Keep the existing scopes: the console REPLACES the whole list.');
}
process.exit(0);
