/**
 * The harder half of _probe_tool_ceiling: does tool choice survive NEAR-DUPLICATES?
 *
 * The first probe showed 5/5 correct up to 240 tools, but its distractors were all clearly
 * different from the target. A real API surface is not like that -- Jira alone has add /
 * update / delete comment, and comment on issue vs on worklog. That resemblance, not the
 * count, is what a wire-everything plan actually buys.
 *
 * Run:  cd server && npx tsx src/spikes/_probe_tool_confusable.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const MODEL = 'gemini-2.5-flash';
const LOCATION = 'us-central1';
const project = (process.env.GEMINI_PROJECT ?? process.env.GEMINI_PROJECT_FALLBACK ?? 'agentmigrations').trim();
const token = await getSaToken();
const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}:generateContent`;

const TARGET = 'jira_add_comment_to_issue';

/** Siblings that a full API surface really would contain alongside the target. */
const CONFUSABLE = [
  ['jira_add_comment_to_worklog', 'Add a comment to a Jira worklog entry.'],
  ['jira_update_comment_on_issue', 'Update an existing comment on a Jira issue.'],
  ['jira_delete_comment_from_issue', 'Delete a comment from a Jira issue.'],
  ['jira_get_comment_on_issue', 'Get a single comment on a Jira issue.'],
  ['jira_list_comments_on_issue', 'List the comments on a Jira issue.'],
  ['jira_add_attachment_to_issue', 'Add an attachment to a Jira issue.'],
  ['jira_add_watcher_to_issue', 'Add a watcher to a Jira issue.'],
  ['jira_add_label_to_issue', 'Add a label to a Jira issue.'],
  ['jira_create_issue_with_comment', 'Create a Jira issue with an initial comment.'],
  ['jira_add_comment_to_sprint', 'Add a comment to a Jira sprint.'],
  ['confluence_add_comment_to_page', 'Add a comment to a Confluence page.'],
  ['jira_notify_issue_watchers', 'Send a note to the watchers of a Jira issue.'],
];

const VERBS = ['get', 'list', 'create', 'update', 'delete', 'search', 'move', 'archive'];
const NOUNS = ['issue', 'project', 'worklog', 'sprint', 'board', 'filter', 'version', 'component',
  'field', 'group', 'user', 'status', 'priority', 'resolution', 'dashboard', 'webhook'];

function decls(n: number) {
  const out: { name: string; description: string; parameters: unknown }[] = [{
    name: TARGET,
    description: 'Add a comment to a Jira issue.',
    parameters: { type: 'object', properties: { issue_key: { type: 'string' }, body: { type: 'string' } }, required: ['issue_key', 'body'] },
  }];
  for (const [name, description] of CONFUSABLE) {
    out.push({ name, description, parameters: { type: 'object', properties: { id: { type: 'string' }, body: { type: 'string' } }, required: ['id'] } });
  }
  let i = 0;
  while (out.length < n) {
    const name = `jira_${VERBS[i % VERBS.length]}_${NOUNS[Math.floor(i / VERBS.length) % NOUNS.length]}_v${Math.floor(i / (VERBS.length * NOUNS.length)) + 1}`;
    if (!out.some((o) => o.name === name)) {
      out.push({ name, description: `${VERBS[i % VERBS.length]} a Jira ${NOUNS[Math.floor(i / VERBS.length) % NOUNS.length]}.`, parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } });
    }
    i++;
  }
  return out.slice(0, n);
}

async function ask(n: number) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: "Add a comment saying 'ping' to issue ABC-1." }] }],
      tools: [{ functionDeclarations: decls(n) }],
      toolConfig: { functionCallingConfig: { mode: 'ANY' } },
    }),
  });
  if (!res.ok) return { ok: false as const, status: res.status };
  const body = (await res.json()) as { candidates?: { content?: { parts?: { functionCall?: { name?: string } }[] } }[] };
  return { ok: true as const, called: body.candidates?.[0]?.content?.parts?.find((p) => p.functionCall)?.functionCall?.name };
}

console.log(`model=${MODEL}  target=${TARGET}  (12 near-duplicate siblings always present)\n`);
const TRIALS = 6;
for (const n of [13, 32, 96, 240, 400, 512]) {
  let hit = 0; const wrong: Record<string, number> = {}; let err = 0;
  for (let t = 0; t < TRIALS; t++) {
    const r = await ask(n);
    if (!r.ok) { err++; continue; }
    if (r.called === TARGET) hit++;
    else wrong[r.called ?? '<none>'] = (wrong[r.called ?? '<none>'] ?? 0) + 1;
  }
  const miss = Object.entries(wrong).map(([k, v]) => `${k}x${v}`).join(' ');
  console.log(`  ${String(n).padStart(3)} tools  correct ${hit}/${TRIALS}${err ? ` err=${err}` : ''}${miss ? `   picked instead: ${miss}` : ''}`);
}
