import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const project = 'studio-enterprise-migration';
  const enginesRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/global/collections/default_collection/engines`, { headers: { Authorization: `Bearer ${token}` } });
  const enginesBody = await enginesRes.json() as { engines?: { name: string }[] };
  for (const e of enginesBody.engines ?? []) {
    const engineId = e.name.split('/').pop();
    const agentsRes = await fetch(`https://discoveryengine.googleapis.com/v1alpha/${e.name}/assistants/default_assistant/agents?pageSize=200`, { headers: { Authorization: `Bearer ${token}` } });
    if (!agentsRes.ok) continue;
    const agentsBody = await agentsRes.json() as { agents?: { name: string; displayName?: string }[] };
    const match = (agentsBody.agents ?? []).find((a) => (a.displayName ?? '').includes('KB-Grounding'));
    console.log(`engine ${engineId}: ${match ? 'FOUND -> ' + match.name : 'not found'}`);
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
