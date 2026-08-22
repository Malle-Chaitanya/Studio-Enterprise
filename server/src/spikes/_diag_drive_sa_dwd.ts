/**
 * Does the DRIVE connector's service account have working DWD - and could it read Gmail?
 *
 * `_diag_gmail_dwd_probe.ts` proved our MAIN service account
 * (studio-enterprise-migration@...) has no Domain-Wide Delegation grants at all: every
 * scope, including admin.directory, fails with `unauthorized_client`.
 *
 * But the Drive connector does NOT use that SA. It uses a customer-supplied
 * `service_account_json` + `impersonate_email` held in Secret Manager
 * (connectorCredentials, connectorId=shared_googledrive). That is a DIFFERENT client id
 * with its own grants, and it is the pattern Gmail should follow.
 *
 * So the question this answers: does THAT service account have working DWD in the target
 * Workspace, and if so, does its grant already cover Gmail?
 *
 *   - drive.readonly PASS  -> DWD works for this client id; the mechanism is sound and
 *                             ledger 1.39's deployed-agent failure is NOT a missing grant.
 *   - gmail.readonly PASS  -> Gmail is reachable today. Plan unblocked, no admin action.
 *   - gmail.readonly FAIL  -> one scope line to add in the Workspace admin console for a
 *                             client id that is ALREADY trusted. Much smaller ask than
 *                             enabling DWD from scratch.
 *
 * NEVER prints the key or a token - only the identity and pass/fail.
 *
 *   cd server && npx tsx src/spikes/_diag_drive_sa_dwd.ts
 */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const SA_SECRET = 'studio-enterprise-shared-googledrive-service-account-json';
const SUBJECT_SECRET = 'studio-enterprise-shared-googledrive-impersonate-email';

const GMAIL_RO = 'https://www.googleapis.com/auth/gmail.readonly';
const DRIVE_RO = 'https://www.googleapis.com/auth/drive.readonly';

async function secret(name: string, token: string): Promise<string | null> {
  const res = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${name}/versions/latest:access`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!res.ok) {
    console.log(`  (secret ${name} -> ${res.status})`);
    return null;
  }
  const json = (await res.json()) as { payload?: { data?: string } };
  return json.payload?.data ? Buffer.from(json.payload.data, 'base64').toString('utf8') : null;
}

async function mint(sa: { client_email: string; private_key: string }, scopes: string[], subject?: string) {
  const client = new JWT({ email: sa.client_email, key: sa.private_key, scopes, subject });
  try {
    const r = await client.getAccessToken();
    return r?.token ? { ok: true, token: r.token } : { ok: false, err: 'no token' };
  } catch (e) {
    return { ok: false, err: (e as Error).message.replace(/\s+/g, ' ').slice(0, 200) };
  }
}

const admin = await getSaToken();
const rawKey = await secret(SA_SECRET, admin);
if (!rawKey) {
  console.log('FAIL: could not read the drive service-account secret. Stopping.');
  process.exit(0);
}
const sa = JSON.parse(rawKey) as { client_email: string; private_key: string; client_id?: string };
const subject = (await secret(SUBJECT_SECRET, admin))?.trim() || 'mia@cloudfuze.com';

console.log(`drive SA    : ${sa.client_email}`);
console.log(`client id   : ${sa.client_id ?? '(absent)'}   <-- what the Workspace admin authorises`);
console.log(`impersonating: ${subject}\n`);

const drive = await mint(sa, [DRIVE_RO], subject);
console.log(`${drive.ok ? 'PASS' : 'FAIL'}  DWD + drive.readonly${drive.ok ? '' : `\n        ${drive.err}`}`);

const gmail = await mint(sa, [GMAIL_RO], subject);
console.log(`${gmail.ok ? 'PASS' : 'FAIL'}  DWD + gmail.readonly${gmail.ok ? '' : `\n        ${gmail.err}`}`);

if (gmail.ok && gmail.token) {
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=3', {
    headers: { Authorization: `Bearer ${gmail.token}` },
  });
  const body = await res.text();
  if (res.ok) {
    const n = (JSON.parse(body) as { messages?: unknown[] }).messages?.length ?? 0;
    console.log(`PASS  gmail users.messages.list -> ${res.status}, ${n} message id(s)`);
  } else {
    console.log(`FAIL  gmail users.messages.list -> ${res.status}\n        ${(/"message":\s*"([^"]+)"/.exec(body)?.[1] ?? body.slice(0, 180))}`);
  }
}
process.exit(0);
