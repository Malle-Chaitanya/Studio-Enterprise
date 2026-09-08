/**
 * How many function declarations can a migrated agent actually carry?
 *
 * WHY MEASURE. The plan of wiring a connector's whole API surface as tools rests on an
 * unstated assumption about how many tools an agent tolerates. Two separate limits matter and
 * they are not the same number:
 *   HARD  - where the API refuses the request outright.
 *   SOFT  - where the model still answers but starts picking the WRONG tool. This one is the
 *           real constraint, because it degrades silently: it looks like a dumb model, not
 *           like a missing capability.
 *
 * Tested against generateContent directly rather than by deploying: an ADK deploy is ~4
 * minutes, and the declaration limit is a model-side property, not a deployment one.
 *
 * Run:  cd server && npx tsx src/spikes/_probe_tool_ceiling.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const MODEL = 'gemini-2.5-flash';
const LOCATION = 'us-central1';
const project = (process.env.GEMINI_PROJECT ?? process.env.GEMINI_PROJECT_FALLBACK ?? 'agentmigrations').trim();

const token = await getSaToken();
const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

/** Realistic filler tools — named like real connector operations, not tool_1..tool_n. */
const VERBS = ['get', 'list', 'create', 'update', 'delete', 'search', 'move', 'copy', 'archive'];
const NOUNS = ['issue', 'project', 'comment', 'worklog', 'sprint', 'board', 'filter', 'version',
  'component', 'attachment', 'label', 'watcher', 'transition', 'user', 'group', 'field'];

function decls(n: number, includeTarget: boolean) {
  const out: unknown[] = [];
  if (includeTarget) {
    out.push({
      name: 'jira_add_comment_to_issue',
      description: 'Add a comment to a Jira issue.',
      parameters: { type: 'object', properties: { issue_key: { type: 'string' }, body: { type: 'string' } }, required: ['issue_key', 'body'] },
    });
  }
  let i = 0;
  while (out.length < n) {
    const name = `jira_${VERBS[i % VERBS.length]}_${NOUNS[Math.floor(i / VERBS.length) % NOUNS.length]}_v${Math.floor(i / (VERBS.length * NOUNS.length)) + 1}`;
    if (name !== 'jira_add_comment_to_issue') {
      out.push({
        name,
        description: `${VERBS[i % VERBS.length]} a Jira ${NOUNS[Math.floor(i / VERBS.length) % NOUNS.length]}.`,
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      });
    }
    i++;
  }
  return out.slice(0, n);
}

async function ask(n: number, prompt: string, withTarget: boolean) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ functionDeclarations: decls(n, withTarget) }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    }),
  });
  const text = await res.text();
  if (!res.ok) return { ok: false as const, status: res.status, detail: text.slice(0, 200) };
  const body = JSON.parse(text) as {
    candidates?: { content?: { parts?: { functionCall?: { name?: string } }[] } }[];
  };
  const called = body.candidates?.[0]?.content?.parts?.find((p) => p.functionCall)?.functionCall?.name;
  return { ok: true as const, called };
}

console.log(`model=${MODEL}  project=${project}\n`);

console.log('--- HARD limit: how many declarations are accepted at all ---');
let lastOk = 0;
for (const n of [16, 64, 128, 256, 512, 768, 1024]) {
  const r = await ask(n, 'List project ABC.', false);
  if (r.ok) { lastOk = n; console.log(`  ${String(n).padStart(4)} declarations  ACCEPTED`); }
  else { console.log(`  ${String(n).padStart(4)} declarations  REFUSED (${r.status}) ${r.detail}`); break; }
}
console.log(`  highest accepted in this sweep: ${lastOk}\n`);

console.log('--- SOFT limit: does it still pick the RIGHT tool as the list grows? ---');
console.log('    asking "Add a comment saying \'ping\' to issue ABC-1" among N distractors');
const PROMPT = "Add a comment saying 'ping' to issue ABC-1.";
const TRIALS = 5;
for (const n of [8, 24, 48, 96, 160, 240]) {
  if (n > lastOk && lastOk) { console.log(`  ${String(n).padStart(4)} tools  skipped (over the hard limit)`); continue; }
  let hit = 0; let refused = 0;
  for (let t = 0; t < TRIALS; t++) {
    const r = await ask(n, PROMPT, true);
    if (!r.ok) { refused++; continue; }
    if (r.called === 'jira_add_comment_to_issue') hit++;
  }
  const note = refused ? `  (${refused}/${TRIALS} errored)` : '';
  console.log(`  ${String(n).padStart(4)} tools  correct ${hit}/${TRIALS}${note}`);
}
