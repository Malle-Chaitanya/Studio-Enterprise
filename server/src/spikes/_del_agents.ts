/** Delete engine agents by id (no mongo).
 *   npx tsx src/_del_agents.ts <project> <engineId> <id1> [id2 ...] */
import 'dotenv/config';
import { getSaToken } from './auth/google.js';

const [PROJECT, ENGINE, ...IDS] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

async function main() {
  if (!PROJECT || !ENGINE || !IDS.length) throw new Error('usage: _del_agents.ts <project> <engineId> <id...>');
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);
  for (const id of IDS) {
    const r = await fetch(`${BASE}/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    console.log(`delete ${id} -> ${r.status}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
