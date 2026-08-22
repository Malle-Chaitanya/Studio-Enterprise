/**
 * Can our service account read a Gmail mailbox at all?
 *
 * This is the gate on the whole Outlook -> Gmail equivalence plan. Gmail reads a MAILBOX,
 * and a mailbox belongs to a person, so the service account reaches one only through
 * Domain-Wide Delegation with an impersonated subject. That mechanism is already
 * known-broken for Drive on deployed agents (ledger 1.39):
 *
 *   auth failed (google-service-account): unauthorized_client: Client is unauthorized to
 *   retrieve access tokens using this method, or client not authorized for any of the
 *   scopes requested.
 *
 * `unauthorized_client` almost always means the SA's CLIENT ID has not been granted that
 * exact scope string in the Workspace admin console (Security -> API controls -> Domain-wide
 * delegation). It is a Workspace-admin action, not a code fix, so the point of this probe is
 * to say precisely WHICH layer fails and therefore who has to do what.
 *
 * Layers, tested independently so a failure localises:
 *   1. plain SA token (no impersonation)     - baseline; proves the key itself is fine
 *   2. DWD token, admin.directory.*          - proves DWD works AT ALL for this SA
 *   3. DWD token, gmail.readonly             - the new scope this plan needs
 *   4. Gmail users.messages.list             - a real read of a real mailbox
 *   5. DWD token, drive.readonly             - comparison: is Drive broken at the GRANT
 *                                              layer, or only inside deployed agents?
 *
 * Layer 5 matters: if Drive's DWD works here but fails on a deployed agent, the bug is in
 * deployment, not the grant, and the ledger's diagnosis needs updating.
 *
 * NEVER prints a token value - only whether one was obtained.
 *
 *   cd server && npx tsx src/spikes/_diag_gmail_dwd_probe.ts [subject-email]
 */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { readFileSync } from 'node:fs';

const SUBJECT = process.argv[2] || 'mia@cloudfuze.com';

const GMAIL_RO = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_RO = 'https://www.googleapis.com/auth/drive.readonly';
const DIR_RO = 'https://www.googleapis.com/auth/admin.directory.user.readonly';

function saCredentials(): { client_email: string; private_key: string; client_id?: string } {
  const raw = process.env.GOOGLE_SA_KEY_JSON;
  if (raw) return JSON.parse(raw);
  const file = process.env.GOOGLE_SA_KEY_FILE || './service_account.json';
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** Returns null + the error string rather than throwing, so every layer is attempted. */
async function mint(scopes: string[], subject?: string): Promise<{ ok: boolean; err?: string; token?: string }> {
  const sa = saCredentials();
  const client = new JWT({ email: sa.client_email, key: sa.private_key, scopes, subject });
  try {
    const res = await client.getAccessToken();
    return res?.token ? { ok: true, token: res.token } : { ok: false, err: 'no token in response' };
  } catch (e) {
    return { ok: false, err: (e as Error).message.replace(/\s+/g, ' ').slice(0, 240) };
  }
}

const line = (n: string, r: { ok: boolean; err?: string }) =>
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${n}${r.ok ? '' : `\n        ${r.err}`}`);

const sa = saCredentials();
console.log(`service account : ${sa.client_email}`);
console.log(`client id       : ${sa.client_id ?? '(absent from key)'}   <-- this is what the Workspace admin authorises`);
console.log(`impersonating   : ${SUBJECT}\n`);

// 1 - baseline
const base = await mint(['https://www.googleapis.com/auth/cloud-platform']);
line('1. plain SA token (cloud-platform, no impersonation)', base);

// 2 - does DWD work at all for this SA?
const dir = await mint([DIR_RO], SUBJECT);
line('2. DWD + admin.directory.user.readonly', dir);

// 3 - the scope this plan needs
const gmail = await mint([GMAIL_RO], SUBJECT);
line('3. DWD + gmail.readonly', gmail);

// 4 - a real read, only if 3 produced a token
if (gmail.ok && gmail.token) {
  const res = await fetch(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=3',
    { headers: { Authorization: `Bearer ${gmail.token}` } },
  );
  const body = await res.text();
  if (res.ok) {
    const n = (JSON.parse(body) as { messages?: unknown[] }).messages?.length ?? 0;
    console.log(`PASS  4. gmail users.messages.list -> ${res.status}, ${n} message id(s) returned`);
  } else {
    const msg = /"message":\s*"([^"]+)"/.exec(body)?.[1] ?? body.slice(0, 200);
    console.log(`FAIL  4. gmail users.messages.list -> ${res.status}\n        ${msg}`);
  }
} else {
  console.log('SKIP  4. gmail users.messages.list (no token from layer 3)');
}

// 5 - is Drive broken at the grant layer, or only inside deployed agents?
const drive = await mint([DRIVE_RO], SUBJECT);
line('5. DWD + drive.readonly (comparison vs ledger 1.39)', drive);

console.log('\n--- READING THIS ---');
console.log('1 FAIL              -> the key itself is bad. Nothing else matters.');
console.log('1 PASS, 2 FAIL      -> DWD is not set up for this SA at all.');
console.log('2 PASS, 3 FAIL      -> DWD works; gmail.readonly is simply not granted to the');
console.log('                       client id above. Workspace admin action, not a code fix.');
console.log('3 PASS, 4 FAIL      -> scope granted but the API refuses; read the message.');
console.log('4 PASS              -> Gmail is reachable. The plan is unblocked.');
console.log('5 PASS + agent fail -> Drive is broken in DEPLOYMENT, not in the grant;');
console.log('                       ledger 1.39 needs correcting.');
process.exit(0);
