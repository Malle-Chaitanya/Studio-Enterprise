/**
 * We've only ever looked at the file's ENTRY inside agentFiles[] (name,
 * fileName, mimeType). We've never GET'd the file resource itself directly —
 * it might carry a processing/indexing status field that explains why every
 * agent with a file attached fails to respond to ANYTHING.
 *
 *   npx tsx src/spikes/_diag_inspect_file_resource.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { assistantBase, defaultDestination } from '../services/gemini.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({ gEmail: { $exists: true } }).sort({ createdAt: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  const project = s.geminiProject ?? '';
  const dest = defaultDestination(project);
  const saToken = await getSaToken(s.gEmail || undefined);

  const agentsRes = await fetch(`${assistantBase(dest)}/agents`, { headers: { Authorization: `Bearer ${saToken}` } });
  const agentsJson = (await agentsRes.json()) as { agents?: { name?: string; displayName?: string; lowCodeAgentDefinition?: { agentFiles?: { name: string; fileName: string }[] } }[] };

  for (const a of agentsJson.agents ?? []) {
    const files = a.lowCodeAgentDefinition?.agentFiles ?? [];
    if (!files.length) continue;
    console.log('\n' + '='.repeat(70));
    console.log(`agent: ${a.displayName}`);
    for (const f of files) {
      console.log(`\n--- GET file resource: ${f.fileName} ---`);
      console.log(`name: ${f.name}`);
      const fileUrl = `https://discoveryengine.googleapis.com/v1alpha/${f.name}`;
      const res = await fetch(fileUrl, { headers: { Authorization: `Bearer ${saToken}` } });
      console.log(`status: ${res.status}`);
      const text = await res.text();
      console.log(text.slice(0, 3000));
    }
  }
  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
