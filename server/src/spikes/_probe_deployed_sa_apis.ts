/** Which Google APIs are ENABLED on the project of the SA the DEPLOYED agents authenticate
 *  as -- not the app's own SA, which is a different account on a different project.
 *
 *  Written after a deployed agent answered "People API returned 403 Forbidden" and three
 *  people read it as a missing scope. It was not: the DWD token minted fine, and Sheets,
 *  People and Docs were simply never enabled on `agentmigrations`. Scope failures and
 *  disabled APIs look identical from inside the agent, so this separates them -- mint the
 *  token first, then make one real call per API. Prints no key material. */
import 'dotenv/config';
import { JWT } from 'google-auth-library';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { getEntraSecret } from '../services/secretManager.js';

await connectMongo();
const row: any = await getDb().collection('connectorCredentials').findOne({ connectorId: 'shared_googlecalendar' });
const own = await getSaToken();
const got = await getEntraSecret(own, `projects/${row.project}/secrets/${row.secretIds.service_account_json}/versions/latest`);
const key = JSON.parse(got.plaintext!);
console.log(`SA: ${key.client_email}   project: ${key.project_id}\n`);

const SUBJECT = process.env.CSGE_SUBJECT ?? 'admin@migrationn.com';
const CHECKS: Array<[string, string, string]> = [
  ['Drive',    'https://www.googleapis.com/auth/drive',    'https://www.googleapis.com/drive/v3/files?pageSize=1&fields=files(id)'],
  ['Sheets',   'https://www.googleapis.com/auth/drive',    'https://sheets.googleapis.com/v4/spreadsheets/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms?fields=spreadsheetId'],
  ['Calendar', 'https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=1'],
  ['People',   'https://www.googleapis.com/auth/contacts', 'https://people.googleapis.com/v1/people/me/connections?personFields=names&pageSize=1'],
  ['Tasks',    'https://www.googleapis.com/auth/tasks',    'https://tasks.googleapis.com/tasks/v1/users/@me/lists?maxResults=1'],
  ['Docs',     'https://www.googleapis.com/auth/drive',    'https://docs.googleapis.com/v1/documents/1x-notareal-doc-id'],
];
for (const [label, scope, url] of CHECKS) {
  let token = '';
  try {
    token = (await new JWT({ email: key.client_email, key: key.private_key, scopes: [scope], subject: SUBJECT }).authorize()).access_token ?? '';
  } catch (e) {
    const m = (e as Error).message.split('\n')[0];
    console.log(`  ${label.padEnd(9)} SCOPE NOT GRANTED  (${scope.replace('https://www.googleapis.com/auth/', '')})  ${/unauthorized_client/i.test(m) ? '' : m.slice(0, 50)}`);
    continue;
  }
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await r.text();
  const disabled = /has not been used in project|is disabled/i.test(body);
  const verdict = disabled ? 'API DISABLED on this project' : r.status === 200 ? 'OK' : r.status === 404 ? 'OK (API live; test id absent)' : `HTTP ${r.status}`;
  console.log(`  ${label.padEnd(9)} ${String(r.status).padEnd(4)} ${verdict}`);
  if (disabled) console.log(`              ${(body.match(/project (\d+)/)?.[0]) ?? ''} — enable ${url.split('/')[2]}`);
}
process.exit(0);
