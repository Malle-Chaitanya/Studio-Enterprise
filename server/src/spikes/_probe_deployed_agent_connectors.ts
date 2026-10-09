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

const PROJECT = process.env.CSGE_PROJECT ?? 'agentmigrations';
const ENGINE = process.env.CSGE_ENGINE ?? '4985854498283978752';
const USER = process.env.CSGE_USER ?? 'admin@migrationn.com';

const TESTS: Array<{ connector: string; path: string; q: string }> = [
  { connector: 'Google Sheets',   path: 'MAP', q: 'What Google Sheets tools do you have? Use one to list what you can reach.' },
  { connector: 'Google Tasks',    path: 'MAP', q: 'Show me my task lists.' },
  { connector: 'Google Drive',    path: 'built', q: 'List the files in my Google Drive.' },
  { connector: 'Google Calendar', path: 'built', q: 'What calendars do I have?' },
  { connector: 'Google Contacts', path: 'built', q: 'Show me my Google contacts.' },
];

const saToken = await getSaToken();
console.log(`engine ${ENGINE}  project ${PROJECT}  as ${USER}\n`);
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
