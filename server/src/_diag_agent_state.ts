/** Inspect a migrated agent's state / sharing / owner to see why it may not show
 *  in a user's "Your agents" UI.  npx tsx src/_diag_agent_state.ts <project> <engineId> <agentId> */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { getSaToken } from './auth/google.js';

const [PROJECT, ENGINE, AGENT] = process.argv.slice(2);
const HOST = 'https://discoveryengine.googleapis.com/v1alpha';

async function main() {
  if (!PROJECT || !ENGINE || !AGENT) throw new Error('usage: _diag_agent_state.ts <project> <engineId> <agentId>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const url = `${HOST}/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  console.log(`GET agent → ${r.status}`);
  console.log(await r.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
