/**
 * Cleanup for _diag_adk_subagent_sanity.ts: delete the throwaway
 * "WorkMate — Subagent Sanity Copy" agent + its Reasoning Engine.
 * The real WorkMate agent (4163375760872779420) is untouched by this —
 * different id, different reasoningEngine.
 *
 * Run: cd server && npx tsx src/spikes/_del_workmate_subagent_sanity_copy.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, deleteAgent } from '../services/gemini.js';

const AGENT_ID = '12380583900237380869';
const REASONING_ENGINE = 'projects/505103737920/locations/us-central1/reasoningEngines/4240391387087896576';
const LOCATION = 'us-central1';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  if (!s?.geminiProject) throw new Error('no session with a geminiProject');
  const saToken = await getSaToken(s.gEmail || undefined);
  const dest = await resolveDestination(s.geminiProject, saToken);

  console.log(`deleting agent ${AGENT_ID}...`);
  const agentDel = await deleteAgent(dest, saToken, AGENT_ID);
  console.log('agent delete result:', JSON.stringify(agentDel));

  console.log(`deleting reasoning engine ${REASONING_ENGINE}...`);
  const res = await fetch(
    `https://${LOCATION}-aiplatform.googleapis.com/v1beta1/${REASONING_ENGINE}?force=true`,
    { method: 'DELETE', headers: { Authorization: `Bearer ${saToken}` } },
  );
  console.log('reasoning engine delete status:', res.status, res.ok || res.status === 404 ? 'OK' : await res.text());
  process.exit(0);
}

main().catch((e) => {
  console.error('FAILED:', e.message);
  process.exit(1);
});
