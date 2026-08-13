/**
 * Does a given Gemini agent id still resolve?
 *
 * The run skipped both agents as "already exists" even though they were deleted in the
 * console, and the existence check logged nothing — so either the check is asking the wrong
 * question, or the delete removed something else. Ask the API the plain question and print
 * the status code.
 *
 * Read-only.  npx tsx src/spikes/_probe_agent_exists.ts <agentId> [...]
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const dest = s?.plan?.destination?.environmentMap?.['https://org32322095.crm.dynamics.com'] ?? {
  project: 'studio-enterprise-migration', engine: 'gemini-enterprise-17847887_1784788734248', assistant: 'default_assistant',
};
console.log(`destination: project=${dest.project} engine=${dest.engine} assistant=${dest.assistant}\n`);
const token = await getSaToken();
const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant ?? 'default_assistant'}`;

for (const id of process.argv.slice(2)) {
  const res = await fetch(`${base}/agents/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  const body = res.ok ? ((await res.json()) as any) : (await res.text()).slice(0, 160);
  console.log(`  agent ${id}: HTTP ${res.status}`);
  if (res.ok) console.log(`     displayName="${body.displayName}"  state=${body.state ?? '-'}`);
  else console.log(`     ${body}`);
}

// And what does the assistant actually LIST right now?
const list = await fetch(`${base}/agents?pageSize=50`, { headers: { Authorization: `Bearer ${token}` } });
if (list.ok) {
  const j = (await list.json()) as { agents?: Array<{ name?: string; displayName?: string; state?: string }> };
  console.log(`\n  ${j.agents?.length ?? 0} agent(s) listed under this assistant:`);
  for (const a of j.agents ?? []) console.log(`     ${a.name?.split('/').pop()}  "${a.displayName}"  state=${a.state ?? '-'}`);
} else {
  console.log(`\n  list failed: HTTP ${list.status}`);
}
process.exit(0);
