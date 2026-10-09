/** Ask the DEPLOYED agent one question per connector and report what actually happened.
 *
 *  The only test that means anything. Every Google API can answer 200 to a direct call and
 *  the agent still fail, because what it holds is a WIRED TOOL, not an API — and the model
 *  will narrate a plausible answer over a tool that returned nothing. So this reads the
 *  RUNTIME's own frames (toolNames / toolSucceeded / toolError), never the prose.
 *
 *  Sheets and Tasks reach generic_rest.py (the operation map); Drive, Calendar and Contacts
 *  are intercepted by hand-written modules at adk_deploy.py:669/690/701 — so a pass means
 *  something different per row, and the output says which. Read-only prompts. Throwaway. */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { chatWithAdkAgent, createAdkSession } from '../services/adkAgentChat.js';
import { connectMongo } from '../db/mongo.js';

const PROJECT = process.env.CSGE_PROJECT ?? 'agentmigrations';
const LOCATION = process.env.CSGE_LOCATION ?? 'us-central1';
const AGENT = process.env.CSGE_AGENT ?? 'Google Connectors';

// DISCOVER the engine; never hardcode one. A hardcoded id made this probe report on a
// 2-hour-old engine built from code that predated the fix under test, which reads as "the
// fix did not work" when nothing had been redeployed yet. The create time is printed with
// the id for the same reason: a verdict about deployed code is meaningless without knowing
// WHICH build answered.
async function newestEngine(token: string): Promise<{ id: string; created: string }> {
  const pinned = process.env.CSGE_ENGINE;
  if (pinned) return { id: pinned, created: '(pinned via CSGE_ENGINE)' };
  const res = await fetch(
    `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines?pageSize=100`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const j = (await res.json()) as {
    reasoningEngines?: { name: string; displayName?: string; createTime?: string }[];
  };
  const mine = (j.reasoningEngines ?? [])
    .filter((e) => (e.displayName ?? '') === AGENT)
    .sort((a, b) => ((a.createTime ?? '') < (b.createTime ?? '') ? 1 : -1));
  if (!mine.length) throw new Error(`no reasoning engine named "${AGENT}" in ${PROJECT}`);
  return { id: mine[0].name.split('/').pop()!, created: mine[0].createTime ?? '(unknown)' };
}
const USER = process.env.CSGE_USER ?? 'admin@migrationn.com';

// A SHEET THE CALLER CAN ACTUALLY OPEN, discovered via Drive rather than hardcoded.
//
// The first version of this asked "list the spreadsheets you can see", which no Sheets
// operation can answer -- listing files is Drive's job, and the six Sheets ops
// (GetTables, GetItems, GetItem, PostItem, PatchItem, DeleteItem) all require a
// spreadsheet id. The model correctly declined to call anything and the probe recorded
// "NO TOOL CALLED", which reads as a broken tool and was a broken question.
const CONTACTS_SCOPE = 'https://www.googleapis.com/auth/drive';
async function findSpreadsheet(): Promise<{ id: string; name: string } | null> {
  const { JWT } = await import('google-auth-library');
  const { getDb } = await import('../db/core.js');
  const { getEntraSecret } = await import('../services/secretManager.js');
  const row: any = await getDb().collection('connectorCredentials').findOne({ connectorId: 'shared_googlecalendar' });
  if (!row?.secretIds?.service_account_json) return null;
  const got = await getEntraSecret(await getSaToken(), `projects/${row.project}/secrets/${row.secretIds.service_account_json}/versions/latest`, { optional: true });
  if (!got.ok || !got.plaintext) return null;
  const key = JSON.parse(got.plaintext);
  const c = new JWT({ email: key.client_email, key: key.private_key, scopes: [CONTACTS_SCOPE], subject: USER });
  const { access_token: t } = await c.authorize();
  const r = await fetch(
    "https://www.googleapis.com/drive/v3/files?q=mimeType%3D'application%2Fvnd.google-apps.spreadsheet'&pageSize=1&fields=files(id,name)",
    { headers: { Authorization: `Bearer ${t}` } },
  );
  const j: any = await r.json();
  const f = (j.files ?? [])[0];
  return f ? { id: f.id, name: f.name } : null;
}
// The credential lookup reads Mongo, so connect before using it.
await connectMongo();
const sheet = await findSpreadsheet();
console.log(sheet
  ? 'sheet under test: ' + sheet.name + ' (' + sheet.id + ')'
  : 'no spreadsheet reachable - the Sheets row will be inconclusive');
console.log('');

const TESTS: Array<{ connector: string; path: string; q: string }> = [
  { connector: 'Google Sheets',   path: 'MAP', q: sheet
      ? `In the Google Sheet with id ${sheet.id}, list the worksheets/tabs it contains.`
      : 'What Google Sheets tools do you have?' },
  { connector: 'Google Tasks',    path: 'MAP', q: 'Show me my task lists.' },
  { connector: 'Google Drive',    path: 'built', q: 'List the files in my Google Drive.' },
  { connector: 'Google Calendar', path: 'built', q: 'What calendars do I have?' },
  { connector: 'Google Contacts', path: 'built', q: 'Show me my Google contacts.' },
];

const saToken = await getSaToken();
const { id: ENGINE, created } = await newestEngine(saToken);
console.log(`engine ${ENGINE}  built ${created}  project ${PROJECT}  as ${USER}\n`);
const sessionId = await createAdkSession(PROJECT, saToken, ENGINE, USER);
console.log(sessionId ? `session ${sessionId}\n` : 'no session — running sessionless\n');

for (const t of TESTS) {
  const r = await chatWithAdkAgent(PROJECT, saToken, {
    reasoningEngineId: ENGINE, message: t.q, userId: USER, ...(sessionId ? { sessionId } : {}),
  });
  const label = `${t.connector} [${t.path}]`.padEnd(30);
  if (!r.ok) { console.log(`${label} TRANSPORT FAIL  ${String(r.error).slice(0, 110)}\n`); continue; }
  // Four outcomes, not two. "Model answered without calling anything" is the one that
  // looks like success and is not.
  const verdict = r.toolError ? 'TOOL ERROR'
    : r.toolSucceeded ? 'TOOL RETURNED DATA'
    : r.toolCalled ? 'tool called, NO data'
    : 'NO TOOL CALLED';
  console.log(`${label} ${verdict}`);
  console.log(`${' '.repeat(30)} tools=[${(r.toolNames ?? []).join(', ') || '—'}]`);
  if (r.toolError) console.log(`${' '.repeat(30)} err: ${String(r.toolError).replace(/\s+/g, ' ').slice(0, 170)}`);
  console.log(`${' '.repeat(30)} "${String(r.answer ?? '').replace(/\s+/g, ' ').trim().slice(0, 165)}"\n`);
}
process.exit(0);
