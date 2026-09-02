/**
 * THE test: does a deployed per-user tool read the CALLER's mailbox?
 *
 * Asks one deployed agent the same question as two different people and compares. Anything
 * other than two different inboxes is a finding:
 *   same answer twice      -> the caller is not reaching the tool
 *   "could not be identified" -> user_id is not arriving in the container
 *   "no mailbox for ..."   -> that person is unmapped, or has no source mailbox
 */
import { getSaToken } from '../auth/google.js';
import { chatWithAdkAgent } from '../services/adkAgentChat.js';

const PROJECT = process.env.GEMINI_PROJECT || 'agentmigrations';
const LOCATION = 'us-central1';
const NAME = process.env.AGENT_NAME || 'Email Manager';
const QUESTION = process.env.Q || 'List the subjects of my 3 most recent emails. Just the subjects.';
const CALLERS = (process.env.CALLERS || 'ben@migrationn.com,ron@migrationn.com').split(',');

const token = await getSaToken();
const r = await fetch(
  `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines`,
  { headers: { Authorization: `Bearer ${token}` } });
const engines = ((await r.json()) as { reasoningEngines?: Array<{ name: string; displayName?: string; createTime?: string }> }).reasoningEngines ?? [];
const mine = engines.filter((e) => (e.displayName ?? '') === NAME)
  .sort((a, b) => String(b.createTime).localeCompare(String(a.createTime)));
if (!mine.length) { console.log(`no reasoning engine named "${NAME}" in ${PROJECT}`); process.exit(1); }
const id = mine[0].name.split('/').pop()!;
console.log(`agent "${NAME}"  engine=${id}  created=${mine[0].createTime}\nQ: ${QUESTION}\n`);

for (const caller of CALLERS) {
  const res = await chatWithAdkAgent(PROJECT, token, {
    reasoningEngineId: id, message: QUESTION, userId: caller.trim(), location: LOCATION,
  });
  console.log(`-------- as ${caller.trim()}`);
  if (!res.ok) { console.log(`ERROR: ${res.error}
`); continue; }
  // The prose is not the evidence. A model with a failed tool will still answer plausibly,
  // so print what the RUNTIME did: which tools fired, whether any returned data, the error.
  console.log(`tools=${(res.toolNames ?? []).join(',') || 'none'}  called=${res.toolCalled}  succeeded=${res.toolSucceeded}`);
  if (res.toolError) console.log(`toolError: ${res.toolError.slice(0, 300)}`);
  console.log((res.answer || '(no prose)').trim().slice(0, 600));
  console.log();
}
