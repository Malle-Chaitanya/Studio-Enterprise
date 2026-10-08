/**
 * What can this service account ACTUALLY reach, per Google API — and what is missing.
 *
 * WHY. Behavioral verification of the operation map means calling the real vendor API and
 * diffing against the Microsoft connector. That needs a credential that can read the data.
 * Before drafting a single map entry it is worth knowing which APIs the SA can reach at
 * all, because the three ways it can fail look identical from a distance and have
 * completely different fixes:
 *
 *   API not enabled on the GCP project   fix in Cloud Console, one click, our side
 *   scope not authorized for DWD         fix in Workspace Admin, customer's side
 *   scope missing from our own request   fix in config.ts, our side
 *
 * Reports only. Reads nothing but list endpoints, writes nothing, and never prints a token,
 * a key, or any file/event content — only whether the call was allowed.
 *
 *   cd server && npx tsx src/spikes/_probe_sa_api_access.ts
 *   cd server && CSGE_IMPERSONATE=admin@customer.com npx tsx src/spikes/_probe_sa_api_access.ts
 *
 * Throwaway diagnostic. Not app code.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { JWT } from 'google-auth-library';
import { config } from '../config.js';

function saKey(): Record<string, unknown> {
  if (config.GOOGLE_SA_KEY_JSON) return JSON.parse(config.GOOGLE_SA_KEY_JSON);
  if (config.GOOGLE_SA_KEY_FILE) return JSON.parse(readFileSync(config.GOOGLE_SA_KEY_FILE, 'utf8'));
  throw new Error('no service account configured (GOOGLE_SA_KEY_JSON / GOOGLE_SA_KEY_FILE)');
}

const IMPERSONATE = process.env.CSGE_IMPERSONATE || undefined;

/**
 * One row per API the Google connectors target. `probe` is the cheapest authenticated READ
 * that API offers — enough to prove reachability without touching customer data.
 */
const TARGETS = [
  { api: 'drive',    scope: 'https://www.googleapis.com/auth/drive.readonly',   connector: 'shared_googledrive',    probe: 'https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)' },
  { api: 'sheets',   scope: 'https://www.googleapis.com/auth/spreadsheets',     connector: 'shared_googlesheet',    probe: 'https://sheets.googleapis.com/v4/spreadsheets/0?fields=spreadsheetId' },
  { api: 'calendar', scope: 'https://www.googleapis.com/auth/calendar.readonly', connector: 'shared_googlecalendar', probe: 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1' },
  { api: 'tasks',    scope: 'https://www.googleapis.com/auth/tasks.readonly',   connector: 'shared_googletasks',    probe: 'https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1' },
  { api: 'people',   scope: 'https://www.googleapis.com/auth/contacts.readonly', connector: 'shared_googlecontacts', probe: 'https://people.googleapis.com/v1/people/me/connections?personFields=names&pageSize=1' },
  { api: 'docs',     scope: 'https://www.googleapis.com/auth/documents.readonly', connector: 'shared_googledocs',   probe: 'https://docs.googleapis.com/v1/documents/0' },
  { api: 'slides',   scope: 'https://www.googleapis.com/auth/presentations.readonly', connector: 'shared_googleslides', probe: 'https://slides.googleapis.com/v1/presentations/0' },
  { api: 'forms',    scope: 'https://www.googleapis.com/auth/forms.body.readonly', connector: 'shared_googleforms',  probe: 'https://forms.googleapis.com/v1/forms/0' },
  { api: 'gmail',    scope: 'https://www.googleapis.com/auth/gmail.readonly',    connector: 'shared_gmail',          probe: 'https://gmail.googleapis.com/gmail/v1/users/me/labels' },
  { api: 'chat',     scope: 'https://www.googleapis.com/auth/chat.spaces.readonly', connector: 'shared_googlechat',  probe: 'https://chat.googleapis.com/v1/spaces?pageSize=1' },
];

type Verdict =
  | 'OK'
  | 'API-DISABLED'       // enable it in our Cloud project
  | 'DWD-NOT-GRANTED'    // customer's Workspace admin must authorize the scope
  | 'SCOPE-INSUFFICIENT'
  | 'NO-MAILBOX'         // SA has no Workspace identity of its own; needs impersonation
  | 'NOT-FOUND'          // reached the API; the dummy id simply does not exist = reachable
  | 'OTHER';

/** Classify from the vendor's own error text. The distinction IS the finding. */
function classify(status: number, body: string): Verdict {
  const b = body.toLowerCase();
  if (status === 200) return 'OK';
  if (b.includes('service_disabled') || b.includes('accessnotconfigured') || b.includes('has not been used in project')) return 'API-DISABLED';
  if (b.includes('access_token_scope_insufficient') || b.includes('insufficient authentication scopes')) return 'SCOPE-INSUFFICIENT';
  if (status === 404 || b.includes('notfound') || b.includes('requested entity was not found')) return 'NOT-FOUND';
  if (b.includes('failedprecondition') || b.includes('must be a member') || b.includes('invalid_grant')) return 'NO-MAILBOX';
  return 'OTHER';
}

/** Short, non-sensitive reason line. Never echoes a token or any resource content. */
function reason(v: Verdict, impersonating: boolean): string {
  switch (v) {
    case 'OK': return 'reachable and authorized';
    case 'NOT-FOUND': return 'reachable (dummy id 404s, which proves auth passed)';
    case 'API-DISABLED': return 'API not enabled on our Cloud project — one click in Console';
    case 'DWD-NOT-GRANTED': return 'scope not authorized for this SA in Workspace Admin (customer side)';
    case 'SCOPE-INSUFFICIENT': return 'token lacks the scope — add it to the request';
    case 'NO-MAILBOX': return impersonating
      ? 'impersonated user has no such resource'
      : 'needs a real Workspace user — rerun with CSGE_IMPERSONATE=<admin email>';
    default: return 'see raw status';
  }
}

const key = saKey();
console.log('service account :', key.client_email);
console.log('client id       :', key.client_id, '  (this is what a Workspace admin authorizes for DWD)');
console.log('project         :', key.project_id);
console.log('impersonating   :', IMPERSONATE ?? '(none — SA\'s own identity)');
console.log('');

const rows: Array<{ api: string; connector: string; verdict: Verdict; detail: string }> = [];

for (const t of TARGETS) {
  let verdict: Verdict = 'OTHER';
  let detail = '';
  try {
    const client = new JWT({
      email: key.client_email as string,
      key: key.private_key as string,
      scopes: [t.scope],
      subject: IMPERSONATE,
    });
    const { access_token: token } = await client.authorize();
    if (!token) throw new Error('no token');
    const res = await fetch(t.probe, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.text();
    verdict = classify(res.status, body);
    detail = `HTTP ${res.status}`;
  } catch (e) {
    const msg = (e as Error).message || '';
    // A DWD scope the Workspace admin has not authorized fails at MINT time, before any
    // API is touched — a different failure from the API refusing the call.
    verdict = /unauthorized_client|invalid_grant/i.test(msg) ? 'DWD-NOT-GRANTED' : 'OTHER';
    detail = msg.split('\n')[0].slice(0, 90);
  }
  rows.push({ api: t.api, connector: t.connector, verdict, detail });
  console.log(
    `${t.api.padEnd(10)}${t.connector.padEnd(26)}${verdict.padEnd(20)}${detail.padEnd(12)}${reason(verdict, Boolean(IMPERSONATE))}`,
  );
}

console.log('\n--- scopes this codebase currently requests (config.ts ALL_SCOPES) ---');
const { ALL_SCOPES } = await import('../config.js');
const have = new Set(ALL_SCOPES.map((s: string) => s.replace(/\.readonly$/, '')));
const missing = TARGETS.filter((t) => !have.has(t.scope.replace(/\.readonly$/, '')));
if (!missing.length) console.log('every probed scope is already requested.');
else {
  console.log('NOT requested — a migrated tool for these would fail to authenticate:');
  for (const m of missing) console.log(`  ${m.connector.padEnd(26)} ${m.scope}`);
}

const reachable = rows.filter((r) => r.verdict === 'OK' || r.verdict === 'NOT-FOUND');
console.log(`\nreachable: ${reachable.length}/${rows.length} APIs`);
process.exit(0);
