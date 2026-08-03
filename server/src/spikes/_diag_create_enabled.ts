/** Test: create an agent with state:ENABLED at creation time (state is immutable
 *  post-create). If it sticks, that's how to make Standard agents gallery-visible.
 *   npx tsx src/_diag_create_enabled.ts <project> <engineId> */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { getSaToken } from './auth/google.js';

const [PROJECT, ENGINE] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

async function main() {
  if (!PROJECT || !ENGINE) throw new Error('usage: _diag_create_enabled.ts <project> <engineId>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const body = {
    displayName: '__cf_enabled_probe__',
    description: 'enabled-state probe',
    state: 'ENABLED',
    lowCodeAgentDefinition: {
      rootAgentId: 'root_agent',
      nodes: [{ id: 'root_agent', displayName: 'probe', llmAgentNode: { description: 'probe', model: 'gemini-2.0-flash', instruction: 'You are a test assistant. Help the user.', subAgentIds: [], selectedTools: { tool: [] } } }],
      draftDisplayName: 'probe', draftDescription: 'probe', draftStarterPrompts: [], draftIcon: { content: '' },
      deployedNodes: [], agentFiles: [], draftSchedules: [], deployedSchedules: [],
    },
  };
  const r = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const text = await r.text();
  console.log(`create with state:ENABLED → ${r.status}`);
  console.log(text.replace(/\s+/g, ' ').slice(0, 600));
  if (r.ok) {
    const id = (JSON.parse(text) as { name?: string; state?: string }).name?.split('/').pop();
    const state = (JSON.parse(text) as { state?: string }).state;
    console.log(`\n>>> Created agent state = ${state}  (id ${id})`);
    if (id) {
      const del = await fetch(`${BASE}/${id}`, { method: 'DELETE', headers: h });
      console.log(`(cleaned up: delete ${del.status})`);
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
