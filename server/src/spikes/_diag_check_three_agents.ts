/**
 * Final state check on the three agents in question: does each have a real
 * deployedNodes (published revision)? Targets the specific known session/
 * project rather than "most recent session" (which can point elsewhere).
 *
 *   npx tsx src/spikes/_diag_check_three_agents.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { assistantBase, defaultDestination } from '../services/gemini.js';

const SESSION_ID = 'g41IyJXaY2a1YT9bFKyz07ynOX8';
const NAMES = ['cs_ge knowledge test agent', 'service operations agent', 'cloudfuze studio migrate', 'service operations agent 1'];

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').findOne({ _id: SESSION_ID as never })) as Session | null;
  if (!s) throw new Error('session not found');
  const project = s.geminiProject ?? '';
  const dest = defaultDestination(project);
  const saToken = await getSaToken(s.gEmail || undefined);

  const agentsRes = await fetch(`${assistantBase(dest)}/agents`, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!agentsRes.ok) throw new Error(`list failed (${agentsRes.status}): ${(await agentsRes.text()).slice(0, 300)}`);
  const agentsJson = (await agentsRes.json()) as { agents?: Record<string, unknown>[] };
  const agents = agentsJson.agents ?? [];

  for (const name of NAMES) {
    const a = agents.find((x) => String(x.displayName ?? '').toLowerCase() === name);
    if (!a) { console.log(`\n"${name}": NOT FOUND (may have been deleted)`); continue; }
    const def = a.lowCodeAgentDefinition as Record<string, unknown> | undefined;
    const files = (def?.agentFiles as { fileName: string }[] | undefined) ?? [];
    console.log(`\n"${a.displayName}"`);
    console.log(`  state: ${a.state}`);
    console.log(`  updateTime: ${a.updateTime}`);
    console.log(`  has deployedNodes: ${!!def?.deployedNodes}`);
    console.log(`  has deployedRootAgentId: ${!!def?.deployedRootAgentId}`);
    console.log(`  agentFiles: ${files.length ? files.map((f) => f.fileName).join(', ') : '(none)'}`);
    console.log(`  deployedAgentFiles present: ${!!def?.deployedAgentFiles}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
