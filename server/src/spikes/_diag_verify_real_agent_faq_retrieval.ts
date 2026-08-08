/**
 * Does the REAL agent from the user's live migration run (agentId
 * 3027457323471599777, low-code, created 2026-08-07 03:06) actually retrieve
 * from the FAQ Entry Dataverse snapshot at query time? Not a throwaway test
 * agent — the actual migrated one. Ask something only answerable from a real
 * row we already confirmed exists (the "supported destinations" FAQ answer).
 *
 *   npx tsx src/spikes/_diag_verify_real_agent_faq_retrieval.ts
 * READ-ONLY (uses the existing verify.ts assist probe, same as the pipeline's
 * own in-run verification step — does not create/modify anything).
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';
import { verifyAgent } from '../services/verify.js';
import type { GeminiDestination } from '../types.js';

// Exact engine from the live migration's own log line — resolveDestination()
// auto-picks WHATEVER engine it discovers first for the project, which can
// differ from the one actually used (this project has multiple engines).
const GEMINI_PROJECT = '231705905417';
const GEMINI_ENGINE = 'gemini-enterprise-17847887_1784788734248';
const G_EMAIL = 'zara@storefuze.com';
const AGENT_ID = '3027457323471599777';
const PROBE =
  'According to your FAQ knowledge, what destinations does CloudFuze support migrating TO? Quote the specific platforms mentioned.';

async function main() {
  const saToken = await getSaToken(G_EMAIL);
  const dest: GeminiDestination = { project: GEMINI_PROJECT, engine: GEMINI_ENGINE, assistant: 'default_assistant' };
  console.log(`project=${dest.project} engine=${dest.engine}`);
  console.log(`Querying real agent ${AGENT_ID}...\n`);

  const v = await verifyAgent(dest, saToken, AGENT_ID, PROBE);
  console.log('verified:', v.verified);
  console.log('note:', v.note);
  console.log('\nANSWER:\n', v.sample);

  const expectSnippets = ['OneDrive', 'SharePoint', 'Microsoft Teams', 'Google Workspace'];
  const hits = expectSnippets.filter((s) => typeof v.sample === 'string' && v.sample.includes(s));
  console.log(`\n--- SUMMARY ---`);
  console.log(`Expected FAQ row content markers found: ${hits.length}/${expectSnippets.length} (${hits.join(', ') || 'none'})`);
  console.log(
    hits.length
      ? 'CONFIRMED: the real migrated agent is retrieving from the Dataverse FAQ Entry snapshot at query time.'
      : 'NOT CONFIRMED from this probe — could be phrasing, could be grounding not reaching the agent. See raw answer above.',
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error('FAILED:', e.message, e.stack);
    process.exit(1);
  });
