/** Experiment: try to promote a PRIVATE agent to ENABLED (gallery-visible) on
 *  Standard, via PATCH state, then a few candidate publish/enable endpoints.
 *  Prints each result (errors reveal valid enum values / correct method).
 *   npx tsx src/spikes/_diag_publish_agent.ts <project> <engineId> <agentId> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';

const [PROJECT, ENGINE, AGENT] = process.argv.slice(2);
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents/${AGENT}`;

async function main() {
  if (!PROJECT || !ENGINE || !AGENT) throw new Error('usage: _diag_publish_agent.ts <project> <engineId> <agentId>');
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const h = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const tries: { label: string; url: string; method: string; body?: string }[] = [
    { label: 'PATCH state=ENABLED', url: `${BASE}?updateMask=state`, method: 'PATCH', body: JSON.stringify({ state: 'ENABLED' }) },
    { label: 'PATCH state=PUBLIC', url: `${BASE}?updateMask=state`, method: 'PATCH', body: JSON.stringify({ state: 'PUBLIC' }) },
    { label: 'POST :enable', url: `${BASE}:enable`, method: 'POST', body: '{}' },
    { label: 'POST :deploy', url: `${BASE}:deploy`, method: 'POST', body: '{}' },
    { label: 'POST :publish (current)', url: `${BASE}:publish`, method: 'POST', body: '{}' },
  ];
  for (const t of tries) {
    try {
      const r = await fetch(t.url, { method: t.method, headers: h, body: t.body });
      const body = (await r.text()).replace(/\s+/g, ' ').slice(0, 300);
      console.log(`\n[${t.label}] → ${r.status}\n  ${body}`);
    } catch (e) {
      console.log(`\n[${t.label}] ERR ${(e as Error).message}`);
    }
  }
  // Re-read state
  const chk = await fetch(BASE, { headers: h });
  const j = (await chk.json()) as { state?: string };
  console.log(`\nFinal state: ${j.state}`);
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
