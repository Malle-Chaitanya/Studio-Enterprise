/**
 * Read-only Gemini diagnostic. Dumps the JSON of the migrated agent(s) from
 * Discovery Engine so we can see the EXACT field where knowledge / data stores
 * attach to a low-code agent — the one piece the public docs don't spell out.
 *
 *   npx tsx src/_diag_gemini_agent.ts ["agent name substring"]
 *
 * HOW TO USE to unblock Fix #3:
 *   1. In the Gemini Enterprise UI, open the migrated agent and manually add a
 *      file (or data store) under "Knowledge", then Save.
 *   2. Run this. Diff the JSON vs. an agent with NO knowledge.
 *   3. The field that appears is where our executor must write the data store
 *      reference. Then the attach step can be built correctly (not guessed).
 *
 * Uses the most recent session's Google service-account token. READ-ONLY.
 */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { getSaToken } from './auth/google.js';
import { assistantBase, defaultDestination } from './services/gemini.js';

const NAME_MATCH = (process.argv[2] || '').toLowerCase();

async function main() {
  await connectMongo();
  const s = (await getDb()
    .collection('migrationSessions')
    .find({})
    .sort({ $natural: -1 })
    .limit(1)
    .next()) as Session | null;
  if (!s) throw new Error('no session found — connect via the web app first');

  const project = s.geminiProject;
  if (!project) throw new Error('session has no geminiProject — connect Google first');
  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = defaultDestination(project);

  const listUrl = `${assistantBase(dest)}/agents`;
  const res = await fetch(listUrl, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!res.ok) throw new Error(`list agents failed (${res.status}): ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { agents?: Record<string, unknown>[] };
  const agents = json.agents ?? [];

  console.log(`\nProject ${project} · engine ${dest.engine} · ${agents.length} agent(s)\n`);
  const matched = NAME_MATCH
    ? agents.filter((a) => String(a.displayName ?? '').toLowerCase().includes(NAME_MATCH))
    : agents;

  for (const a of matched) {
    console.log('='.repeat(70));
    console.log(`displayName: ${a.displayName}`);
    // Highlight any field that mentions knowledge / data store / grounding.
    const keys = Object.keys(a);
    const knowledgeKeys = keys.filter((k) => /knowledge|datastore|grounding|search|file|source/i.test(k));
    console.log(`top-level keys: ${keys.join(', ')}`);
    if (knowledgeKeys.length) console.log(`⭐ knowledge-related keys: ${knowledgeKeys.join(', ')}`);
    console.log('\nFULL JSON:\n' + JSON.stringify(a, null, 2));
  }
  if (!matched.length) console.log('(no agents matched — pass a different name substring, or omit it to dump all)');

  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
