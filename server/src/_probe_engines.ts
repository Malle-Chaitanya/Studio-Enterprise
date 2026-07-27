/**
 * Probe: what "destinations" does Gemini Enterprise actually expose for a
 * project, and can we list them via API? Determines feasibility of the
 * "discover destinations + create per environment" UX.
 *   npx tsx src/_probe_engines.ts <sessionId>
 */
import 'dotenv/config';
import { connectMongo } from './db/mongo.js';
import { getDb } from './db/core.js';
import type { Session } from './sessionStore.js';
import { getSaToken } from './auth/google.js';

const SESSION_ID = process.argv[2];
const LOC = 'global';

async function get(url: string, token: string) {
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, body: await res.text() };
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').findOne({ _id: SESSION_ID as never })) as Session | null;
  if (!s) throw new Error('session not found');
  const project = s.geminiProject ?? '';
  const token = await getSaToken(s.gEmail);
  console.log(`project=${project}  as=${s.gEmail}\n`);

  const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/${LOC}`;

  // 1) Collections
  const cols = await get(`${base}/collections`, token);
  console.log(`GET /collections → ${cols.status}`);
  console.log(cols.body.slice(0, 400));

  // 2) Engines (apps) under the default collection — these are the closest
  //    thing to a "destination environment" we could map to.
  const eng = await get(`${base}/collections/default_collection/engines`, token);
  console.log(`\nGET /collections/default_collection/engines → ${eng.status}`);
  try {
    const j = JSON.parse(eng.body) as { engines?: { name: string; displayName?: string; solutionType?: string }[] };
    const list = j.engines ?? [];
    console.log(`  ${list.length} engine(s):`);
    for (const e of list) console.log(`   · ${e.displayName ?? '(no name)'}  [${e.name.split('/').pop()}]  solution=${e.solutionType ?? '?'}`);
  } catch {
    console.log(eng.body.slice(0, 500));
  }

  // 3) Assistants under the hardcoded engine we currently use.
  const asst = await get(`${base}/collections/default_collection/engines/agentspace-engine/assistants`, token);
  console.log(`\nGET …/engines/agentspace-engine/assistants → ${asst.status}`);
  console.log(asst.body.slice(0, 300));
  process.exit(0);
}

main().catch((e) => { console.error('PROBE FAILED:', e.message); process.exit(1); });
