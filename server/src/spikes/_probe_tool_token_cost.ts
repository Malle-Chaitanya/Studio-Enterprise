/**
 * What do 512 function declarations COST per message?
 *
 * The declarations are re-sent with every request, so a wire-everything agent pays for its
 * whole API surface on each turn -- unlike the hard 512 cap, this is a recurring cost, and it
 * is the one remaining argument against the plan now that selection accuracy measured clean.
 *
 * Run:  cd server && npx tsx src/spikes/_probe_tool_token_cost.ts
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const MODEL = 'gemini-2.5-flash';
const LOCATION = 'us-central1';
const project = (process.env.GEMINI_PROJECT ?? process.env.GEMINI_PROJECT_FALLBACK ?? 'agentmigrations').trim();
const token = await getSaToken();
const url = `https://${LOCATION}-aiplatform.googleapis.com/v1/projects/${project}/locations/${LOCATION}/publishers/google/models/${MODEL}:countTokens`;

const VERBS = ['get', 'list', 'create', 'update', 'delete', 'search', 'move', 'archive'];
const NOUNS = ['issue', 'project', 'worklog', 'sprint', 'board', 'filter', 'version', 'component',
  'field', 'group', 'user', 'status', 'priority', 'resolution', 'dashboard', 'webhook'];

function decls(n: number) {
  const out = [];
  for (let i = 0; out.length < n; i++) {
    const verb = VERBS[i % VERBS.length];
    const noun = NOUNS[Math.floor(i / VERBS.length) % NOUNS.length];
    out.push({
      name: `jira_${verb}_${noun}_v${Math.floor(i / (VERBS.length * NOUNS.length)) + 1}`,
      // Description length matters as much as count, so this mirrors a real generated one.
      description: `${verb} a Jira ${noun}. Calls the Jira Cloud REST API v3 endpoint for ${noun}s. Returns the ${noun} as JSON, or an error object when the call fails.`,
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: `Identifier of the ${noun}.` },
          expand: { type: 'string', description: 'Comma-separated list of fields to expand.' },
          max_results: { type: 'integer', description: 'Maximum number of results to return.' },
        },
        required: ['id'],
      },
    });
  }
  return out.slice(0, n);
}

async function count(n: number) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: "Add a comment saying 'ping' to issue ABC-1." }] }],
      ...(n ? { tools: [{ functionDeclarations: decls(n) }] } : {}),
    }),
  });
  const t = await res.text();
  if (!res.ok) return { err: `${res.status} ${t.slice(0, 160)}` };
  return { tokens: (JSON.parse(t) as { totalTokens?: number }).totalTokens ?? 0 };
}

const base = await count(0);
console.log(`prompt alone: ${base.tokens ?? base.err} tokens\n`);
for (const n of [12, 48, 128, 256, 512]) {
  const r = await count(n);
  if (r.err) { console.log(`  ${String(n).padStart(3)} tools  ERROR ${r.err}`); continue; }
  const overhead = (r.tokens ?? 0) - (base.tokens ?? 0);
  console.log(`  ${String(n).padStart(3)} tools  ${String(r.tokens).padStart(6)} tokens  (+${overhead} for tools, ~${Math.round(overhead / n)}/tool)`);
}
