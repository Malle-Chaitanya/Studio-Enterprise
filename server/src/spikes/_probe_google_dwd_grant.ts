/**
 * Which of the Google connector scopes does the Workspace admin's DWD grant actually cover?
 *
 * The deployed tools do NOT use the app service account - they use the connector service
 * account held in Secret Manager, whose own `client_id` is what the admin authorises. So the
 * only honest way to answer "is this scope granted" is to mint a real DWD token with THAT
 * key for THAT one scope and see whether Google refuses it.
 *
 * `invalid_grant` means the subject could not be resolved (wrong user), NOT a missing scope -
 * reported separately so a bad subject never masquerades as a missing grant.
 *
 * Never prints the key, the token, or any secret value - only identity and verdict.
 *
 *   cd server && npx tsx src/spikes/_probe_google_dwd_grant.ts
 *   cd server && CSGE_IMPERSONATE=someone@customer.com npx tsx src/spikes/_probe_google_dwd_grant.ts
 */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { getSaToken } from '../auth/google.js';
import { GOOGLE_APPS } from '../connectors/googleCatalog.js';

const PROJECT = process.env.CSGE_SECRET_PROJECT ?? 'agentmigrations';
const WANT_CLIENT_ID = process.env.CSGE_DWD_CLIENT_ID ?? '116522083449752032780';

// A key file can be tested BEFORE it is stored anywhere: the whole point of checking a
// credential is to find out whether it works before a migration depends on it.
const KEY_FILE = process.env.CSGE_SA_KEY_FILE;

const saToken = KEY_FILE ? '' : await getSaToken();

async function sm<T>(path: string): Promise<T | null> {
  const res = await fetch(`https://secretmanager.googleapis.com/v1/${path}`, {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

// 1. Find the service account key whose client_id is the one the admin authorised.
//    A file given on the command line short-circuits the Secret Manager scan.
type SaKeyFile = { client_email: string; private_key: string; client_id?: string };
let fileKey: SaKeyFile | null = null;
if (KEY_FILE) {
  const { readFileSync } = await import('node:fs');
  fileKey = JSON.parse(readFileSync(KEY_FILE, 'utf8')) as SaKeyFile;
}

type SecretList = { secrets?: { name: string }[]; nextPageToken?: string };
const names: string[] = [];
if (!fileKey) {
let page = '';
for (;;) {
  const list = await sm<SecretList>(
    `projects/${PROJECT}/secrets?pageSize=200${page ? `&pageToken=${page}` : ''}`,
  );
  if (!list) break;
  for (const s of list.secrets ?? []) names.push(s.name.split('/').pop()!);
  if (!list.nextPageToken) break;
  page = list.nextPageToken;
}
}
if (!fileKey) console.log(`project ${PROJECT}: ${names.length} secret(s)`);

const saCandidates = names.filter((n) => /service-account-json$/.test(n));
const subjCandidates = names.filter((n) => /impersonate-email$/.test(n));

type SaKey = { client_email: string; private_key: string; client_id?: string };
let sa: SaKey | null = fileKey;
let saFrom = KEY_FILE ? 'key file given on the command line' : '';
for (const n of fileKey ? [] : saCandidates) {
  const got = await sm<{ payload?: { data?: string } }>(
    `projects/${PROJECT}/secrets/${n}/versions/latest:access`,
  );
  if (!got?.payload?.data) continue;
  try {
    const k = JSON.parse(Buffer.from(got.payload.data, 'base64').toString('utf8')) as SaKey;
    if (k.client_id === WANT_CLIENT_ID) { sa = k; saFrom = n; break; }
    if (!sa) { sa = k; saFrom = n; }           // fallback: first readable key
  } catch { /* not a key */ }
}
if (!sa) { console.log(`no readable service-account secret in ${PROJECT}. Stopping.`); process.exit(0); }

// 2. Resolve the subject to impersonate.
let subject = process.env.CSGE_IMPERSONATE ?? '';
if (!subject && !fileKey) {
  for (const n of subjCandidates) {
    const got = await sm<{ payload?: { data?: string } }>(
      `projects/${PROJECT}/secrets/${n}/versions/latest:access`,
    );
    const v = got?.payload?.data ? Buffer.from(got.payload.data, 'base64').toString('utf8').trim() : '';
    if (v.includes('@')) { subject = v; break; }
  }
}
if (!subject) { console.log('no impersonate email found; set CSGE_IMPERSONATE=<admin@domain>'); process.exit(0); }

console.log(`SA          : ${sa.client_email}   (from ${saFrom})`);
console.log(`client id   : ${sa.client_id ?? '(absent)'}${sa.client_id === WANT_CLIENT_ID ? '  <-- the authorised one' : '  <-- NOT the expected client id'}`);
console.log(`impersonating: ${subject}\n`);

// 3. One real DWD mint per declared connector scope.
async function verdict(scope: string): Promise<'GRANTED' | 'NOT GRANTED' | 'SUBJECT?'> {
  try {
    const c = new JWT({ email: sa!.client_email, key: sa!.private_key, scopes: scope.split(/\s+/), subject });
    const r = await c.getAccessToken();
    return r?.token ? 'GRANTED' : 'NOT GRANTED';
  } catch (e) {
    const m = (e as Error).message;
    if (/invalid_grant/.test(m)) return 'SUBJECT?';      // subject unresolvable != scope missing
    return 'NOT GRANTED';
  }
}

const missing: string[] = [];
for (const c of GOOGLE_APPS) {
  const v = await verdict(c.scope);
  const mark = v === 'GRANTED' ? 'ok ' : v === 'SUBJECT?' ? ' ? ' : '>>>';
  console.log(`${mark} ${c.id.padEnd(24)} ${v.padEnd(12)} ${c.scope.replace(/https:\/\/www\.googleapis\.com\//g, '')}`);
  if (v === 'NOT GRANTED') missing.push(...c.scope.split(/\s+/));
}

console.log('');
if (missing.length === 0) {
  console.log('all declared connector scopes are granted.');
} else {
  console.log(`${[...new Set(missing)].length} scope(s) still to add for client id ${sa.client_id}:`);
  for (const s of [...new Set(missing)]) console.log('  ' + s);
}
process.exit(0);
