/** Creates ONE minimal, clearly-named low-code agent so the customer can check the real
 *  Gemini Enterprise "Your agents" gallery view themselves — the user showed a screenshot
 *  where "My Agent" (their own agents list) displays a "Draft" badge, which appears to
 *  contradict GEMINI-CHATBOT-CLAIMS-FACTCHECK.md's conclusion that a PRIVATE low-code
 *  agent never appears in any gallery view. Rather than guess which is right, this creates
 *  a real one to check directly. Does NOT touch any existing agent — purely additive.
 *  Prints the created agent's id and state so it's easy to find and delete afterward
 *  (via _diag_agents.ts <project> delete <id>).
 *  No mongo required for the create call itself, but resolveDestination needs Mongo for
 *  the impersonation-email lookup (same as _diag_agents.ts) — left in for consistency.
 *   npx tsx src/spikes/_diag_create_lowcode_gallery_test.ts <projectNumber> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, createAgent } from '../services/gemini.js';
import type { MappedAgent } from '../types.js';

const PROJECT = process.argv[2];

async function main() {
  if (!PROJECT) throw new Error('usage: _diag_create_lowcode_gallery_test.ts <projectNumber>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined;
  const token = await getSaToken(impersonate);
  const dest = await resolveDestination(PROJECT, token);
  console.log(`Project: ${PROJECT}\nEngine: ${dest.engine}\nImpersonating: ${impersonate ?? '(SA directly)'}\n`);

  const testAgent = {
    displayName: 'ZZZ Low-Code Gallery Visibility Test — safe to delete',
    description: 'Throwaway test agent created to check whether a PRIVATE low-code agent shows up in the Gemini Enterprise "Your agents" gallery (with or without a Draft badge). Not a real migrated agent — delete anytime.',
    instruction: 'You are a test agent. If anyone actually talks to you, say this is a throwaway diagnostic agent and can be deleted.',
    starterPrompts: [{ text: 'Hello' }],
    model: 'gemini-2.5-flash',
    tools: [],
    fidelityNotes: [],
  } as unknown as MappedAgent;

  const result = await createAgent(dest, token, testAgent);
  console.log('Create result:', JSON.stringify(result, null, 2));

  if (result.created && result.agentId) {
    console.log(
      `\n✅ Created. agentId=${result.agentId}  state=${result.state}\n\n` +
        `Next step (manual): open your Gemini Enterprise "Your agents" view ` +
        `(vertexaisearch.cloud.google.com/home/cid/<your-cid>/r/agents) as the SAME account ` +
        `that owns this agent (${impersonate ?? 'the service account'}), and check whether ` +
        `"ZZZ Low-Code Gallery Visibility Test" appears there, and if so, whether it carries ` +
        `a "Draft" badge like the "My Agent" entries in your screenshot.\n\n` +
        `To delete this test agent afterward:\n` +
        `  npx tsx src/spikes/_diag_agents.ts ${PROJECT} delete ${result.agentId}`,
    );
  } else {
    console.log(`\n❌ Create did not succeed as expected: ${result.error ?? 'unknown'}`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});