/** Is there a real "Deal Desk" agent live in Gemini Enterprise right now (checking the
 *  actual destination directly, not this project's own Mongo bookkeeping)? Read-only.
 *  npx tsx src/spikes/_diag_check_dealdesk_gemini_live.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const s = (await getDb()
  .collection('migrationSessions')
  .find({ geminiProject: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;

console.log('Stored session geminiProject:', s?.geminiProject ?? 'NONE FOUND');

const saToken = await getSaToken();
const candidateProjects = [s?.geminiProject, 'studio-enterprise-migration', 'agentmigrations'].filter(
  (v, i, arr) => v && arr.indexOf(v) === i,
) as string[];

for (const project of candidateProjects) {
  console.log(`\n=== Trying project: ${project} ===`);
  try {
    const dest = await resolveDestination(project, saToken);
    console.log(`  Resolved engine: ${dest.engine ?? '(n/a)'} collection=${dest.collection ?? '(n/a)'}`);
    const url = `${assistantBase(dest)}/agents?pageSize=1000`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${saToken}` } });
    if (!res.ok) {
      console.log(`  Agents list fetch failed: ${res.status} ${await res.text().then((t) => t.slice(0, 300))}`);
      continue;
    }
    const json = (await res.json()) as { agents?: Array<{ name: string; displayName?: string; state?: string }> };
    const agents = json.agents ?? [];
    console.log(`  Total agents in this engine: ${agents.length}`);
    const dealDesk = agents.filter((a) => /deal\s*desk/i.test(a.displayName ?? ''));
    console.log(`  Matching "Deal Desk": ${dealDesk.length}`);
    for (const a of dealDesk) console.log(`    - ${a.displayName} (state=${a.state}, name=${a.name})`);
    if (!dealDesk.length && agents.length) {
      console.log(`  All agent display names in this engine: ${agents.map((a) => a.displayName).join(', ')}`);
    }
  } catch (e) {
    console.log(`  Failed: ${(e as Error).message}`);
  }
}
process.exit(0);
