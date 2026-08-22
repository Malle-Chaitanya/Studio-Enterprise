/**
 * Why does a Teams meeting chat report "5 messages, all empty"?
 *
 * The deployed agent said exactly that. Two possibilities with opposite fixes:
 *   - the messages ARE empty (system events: joined, left, call ended) and the tool should
 *     say so rather than calling them messages, or
 *   - the tool is dropping real content (wrong field, or HTML stripped to nothing).
 * Guessing between them would either hide a bug or add a lie. This prints the raw shape.
 *
 *   cd server && npx tsx src/spikes/_diag_teams_message_shape.ts <chatId>
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const CHAT = process.argv[2] || '19:meeting_NDhlN2JkMTUtNTA3OS00Mzc1LWIxNjEtMTc0NjY3ZDViMzMz@thread.v2';
const PROJECT = 'studio-enterprise-migration';
const admin = await getSaToken();
async function sec(n: string): Promise<string> {
  const r = await fetch(
    `https://secretmanager.googleapis.com/v1/projects/${PROJECT}/secrets/${n}/versions/latest:access`,
    { headers: { Authorization: `Bearer ${admin}` } });
  const j = (await r.json()) as { payload?: { data?: string } };
  return Buffer.from(j.payload?.data ?? '', 'base64').toString('utf8').trim();
}
const [t, ci, cs] = await Promise.all([
  sec('studio-enterprise-ms-graph-tenant-id'),
  sec('studio-enterprise-ms-graph-client-id'),
  sec('studio-enterprise-ms-graph-client-secret'),
]);
const tr = await fetch(`https://login.microsoftonline.com/${t}/oauth2/v2.0/token`, {
  method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'client_credentials', client_id: ci, client_secret: cs,
    scope: 'https://graph.microsoft.com/.default' }),
});
const tok = (await tr.json() as { access_token: string }).access_token;

const res = await fetch(
  `https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(CHAT)}/messages?$top=10`,
  { headers: { Authorization: `Bearer ${tok}` } });
const body = await res.text();
if (!res.ok) { console.log(`FAIL ${res.status} ${body.slice(0, 300)}`); process.exit(0); }
const j = JSON.parse(body) as { value?: Array<Record<string, unknown>> };
console.log(`${(j.value ?? []).length} message(s)\n`);
for (const m of j.value ?? []) {
  const b = (m.body ?? {}) as { content?: string; contentType?: string };
  console.log(`type=${m.messageType}  from=${JSON.stringify(m.from)?.slice(0, 60)}`);
  console.log(`  contentType=${b.contentType}  contentLen=${(b.content ?? '').length}`);
  console.log(`  content=${JSON.stringify((b.content ?? '').slice(0, 160))}`);
  if (m.eventDetail) console.log(`  eventDetail=${JSON.stringify(m.eventDetail).slice(0, 160)}`);
  console.log('');
}
process.exit(0);
