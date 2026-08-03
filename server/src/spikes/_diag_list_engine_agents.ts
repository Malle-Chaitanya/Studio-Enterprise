/** List the engine's Discovery Engine agents (no mongo). Confirms whether an
 *  Agent-Studio/ADK agent ("Manual Test Agent") lives in the SAME engine as the
 *  migrated low-code agents, or a different system.
 *   npx tsx src/spikes/_diag_list_engine_agents.ts <project> <engineId> */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const [PROJECT, ENGINE] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

async function main() {
  if (!PROJECT || !ENGINE) throw new Error('usage: _diag_list_engine_agents.ts <project> <engineId>');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  const r = await fetch(BASE, { headers: { Authorization: `Bearer ${token}` } });
  const j = (await r.json()) as { agents?: { name: string; displayName?: string; state?: string }[] };
  console.log(`GET agents -> ${r.status}\n`);
  for (const a of j.agents ?? []) {
    const id = a.name.split('/').pop();
    console.log(`  ${a.state?.padEnd(8) ?? '?'}  ${id}   "${a.displayName ?? ''}"`);
  }
  console.log(`\n(${j.agents?.length ?? 0} agents in this ENGINE. Looking for "Manual Test Agent"…)`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
