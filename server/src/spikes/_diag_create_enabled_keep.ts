/** Create an agent with state:ENABLED and LEAVE it in place (no auto-delete) so
 *  we can check whether (a) ENABLED sticks at creation and (b) it then lists in
 *  the Standard gallery. Prints the returned state + a direct agent link.
 *   npx tsx src/_diag_create_enabled_keep.ts <project> <engineId> [cid] */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { getSaToken } from './auth/google.js';

const [PROJECT, ENGINE, CID] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

async function main() {
  if (!PROJECT || !ENGINE) throw new Error('usage: _diag_create_enabled_keep.ts <project> <engineId> [cid]');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const body = {
    displayName: 'ZZ ENABLED Test Agent',
    description: 'Test: created with state:ENABLED to check Standard gallery listing.',
    state: 'ENABLED',
    lowCodeAgentDefinition: {
      rootAgentId: 'root_agent',
      nodes: [{ id: 'root_agent', displayName: 'ZZ ENABLED Test Agent', llmAgentNode: { description: 'test', model: 'gemini-2.0-flash', instruction: 'You are a friendly test assistant. Greet the user and offer to help.', subAgentIds: [], selectedTools: { tool: [] } } }],
      draftDisplayName: 'ZZ ENABLED Test Agent', draftDescription: 'test', draftStarterPrompts: [], draftIcon: { content: '' },
      deployedNodes: [], agentFiles: [], draftSchedules: [], deployedSchedules: [],
    },
  };
  const r = await fetch(BASE, { method: 'POST', headers: h, body: JSON.stringify(body) });
  const text = await r.text();
  console.log(`create with state:ENABLED -> ${r.status}`);
  if (!r.ok) { console.log(text.replace(/\s+/g, ' ').slice(0, 500)); process.exit(0); }

  const j = JSON.parse(text) as { name?: string; state?: string };
  const id = j.name?.split('/').pop();
  console.log(`\n>>> Returned state = ${j.state}   (agent id ${id})`);

  // Also try :publish (some tiers require a published revision to gallery-list)
  const pub = await fetch(`${BASE}/${id}:publish`, { method: 'POST', headers: h, body: '{}' });
  console.log(`:publish -> ${pub.status}`);

  // Re-read state after publish
  const chk = await fetch(`${BASE}/${id}`, { headers: h });
  const cj = (await chk.json()) as { state?: string };
  console.log(`state after publish = ${cj.state}`);

  if (CID) console.log(`\nDirect link:\n  https://vertexaisearch.cloud.google.com/home/cid/${CID}/r/agent/${id}`);
  console.log(`\n(Agent LEFT in place. To remove later: npx tsx src/_diag_agents.ts ${PROJECT} delete ${id})`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
