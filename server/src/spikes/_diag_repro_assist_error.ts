/**
 * Reproduce "Something went wrong while answering your question" from the
 * Gemini Enterprise UI by calling the same agent's :assist endpoint directly,
 * so we see the real HTTP status + error body instead of the UI's generic
 * message. Read-only against the already-created agent.
 *
 *   npx tsx src/spikes/_diag_repro_assist_error.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { assistantBase, defaultDestination } from '../services/gemini.js';

const PROBE = 'Can you write some customer-facing marketing copy about our latest migration feature?';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({ gEmail: { $exists: true } }).sort({ createdAt: -1 }).limit(1).next()) as Session | null;
  if (!s) throw new Error('no session');
  const project = s.geminiProject ?? '';
  const dest = defaultDestination(project);
  const saToken = await getSaToken(s.gEmail || undefined);

  const agentsRes = await fetch(`${assistantBase(dest)}/agents`, { headers: { Authorization: `Bearer ${saToken}` } });
  if (!agentsRes.ok) throw new Error(`list agents failed (${agentsRes.status}): ${(await agentsRes.text()).slice(0, 300)}`);
  const agentsJson = (await agentsRes.json()) as { agents?: { name?: string; displayName?: string }[] };
  const match = (agentsJson.agents ?? []).find((a) => (a.displayName ?? '').toLowerCase().includes('cloudfuze studio migrate'));
  if (!match?.name) throw new Error('agent not found');
  const agentId = match.name.split('/').pop()!;
  console.log(`agent: ${match.displayName}  agentId=${agentId}\n`);

  const assistUrl = `${assistantBase(dest)}:assist`;
  console.log(`POST ${assistUrl}`);
  console.log(`query: "${PROBE}"\n`);

  const res = await fetch(assistUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: { text: PROBE }, agentId }),
  });

  console.log(`status: ${res.status} ${res.statusText}`);
  const text = await res.text();
  console.log(`\nbody:\n${text.slice(0, 4000)}`);
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
