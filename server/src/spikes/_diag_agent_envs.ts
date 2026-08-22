/** Which environment does each recommended test agent live in? The UI pairs ONE Dataverse
 *  environment to one Gemini app at a time, so a 5-agent plan that spans environments is two
 *  passes, not one — better to know before clicking than halfway through. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
const WANT = ['Enterprise Migration Knowledge', 'Teams Coordinator', 'Email Manager', 'HubSpot Agent', 'Confluence Knowledge Assistant'];
await connectMongo();
const staged = (await getDb().collection('stagedAgents').find({}).toArray()) as Array<Record<string, unknown>>;
const seen = new Map<string, Set<string>>();
for (const r of staged) {
  const n = String(r.displayName ?? '');
  if (!WANT.includes(n)) continue;
  const s = seen.get(n) ?? new Set<string>();
  s.add(`${String(r.envUrl ?? '?')}  [sourceId ${String(r.sourceId ?? '?').slice(0, 8)}]`);
  seen.set(n, s);
}
for (const n of WANT) {
  console.log(`${n}`);
  for (const e of seen.get(n) ?? ['  *** NOT FOUND in stagedAgents under this exact name ***']) console.log(`   ${e}`);
}
process.exit(0);
