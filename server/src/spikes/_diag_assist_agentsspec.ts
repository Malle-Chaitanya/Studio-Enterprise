/**
 * Official docs (partially) confirm AssistRequest/StreamAssistRequest has an
 * `agentsSpec.agentSpecs[]` field (not the flat `agentId` our verify.ts uses,
 * which Google rejects outright). Test that shape directly so we can read a
 * REAL business-logic error instead of the browser's generic message.
 *
 *   npx tsx src/spikes/_diag_assist_agentsspec.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { assistantBase, defaultDestination } from '../services/gemini.js';

const PROBE = 'hi';

async function tryShape(label: string, url: string, body: unknown, saToken: string) {
  console.log('\n' + '='.repeat(70));
  console.log(label);
  console.log('body:', JSON.stringify(body));
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(`status: ${res.status}`);
  console.log((await res.text()).slice(0, 3000));
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({ gEmail: { $exists: true } }).sort({ createdAt: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  const project = s.geminiProject ?? '';
  const dest = defaultDestination(project);
  const saToken = await getSaToken(s.gEmail || undefined);

  const agentsRes = await fetch(`${assistantBase(dest)}/agents`, { headers: { Authorization: `Bearer ${saToken}` } });
  const agentsJson = (await agentsRes.json()) as { agents?: { name?: string; displayName?: string }[] };
  const broken = (agentsJson.agents ?? []).find((a) => (a.displayName ?? '').toLowerCase().includes('cloudfuze studio migrate'));
  const working = (agentsJson.agents ?? []).find((a) => (a.displayName ?? '').toLowerCase().includes('service operations agent 1'));
  if (!broken?.name || !working?.name) throw new Error('agents not found');

  const assistUrl = `${assistantBase(dest)}:assist`;

  await tryShape('BROKEN agent (CloudFuze Studio Migrate) via agentsSpec.agentSpecs', assistUrl, {
    query: { text: PROBE },
    agentsSpec: { agentSpecs: [{ agent: broken.name }] },
  }, saToken);

  await tryShape('WORKING agent (Service Operations Agent 1) via agentsSpec.agentSpecs — control test', assistUrl, {
    query: { text: PROBE },
    agentsSpec: { agentSpecs: [{ agent: working.name }] },
  }, saToken);

  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
