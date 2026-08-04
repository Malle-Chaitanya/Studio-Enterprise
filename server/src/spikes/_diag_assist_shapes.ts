/**
 * The UI shows a generic "something went wrong" for every message to this
 * agent, even with zero knowledge sources attached — only the Google Search
 * connector is unusual about it. Our own verify.ts assist call uses a
 * malformed request shape (confirmed: Google rejects `agentId` as an unknown
 * top-level field), so we've never actually seen a real error for THIS
 * agent's failure. This script tries several plausible request shapes for the
 * v1alpha AssistantService.Assist call so we can read Google's real error
 * instead of the UI's generic message.
 *
 *   npx tsx src/spikes/_diag_assist_shapes.ts
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
  console.log('='.repeat(70));
  console.log('POST', url);
  console.log('body:', JSON.stringify(body));
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  console.log(`\nstatus: ${res.status}`);
  console.log(text.slice(0, 2000));
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
  const match = (agentsJson.agents ?? []).find((a) => (a.displayName ?? '').toLowerCase().includes('cloudfuze studio migrate'));
  if (!match?.name) throw new Error('agent not found');
  console.log(`agent resource name: ${match.name}`);

  const assistUrl = `${assistantBase(dest)}:assist`;

  await tryShape('Shape A: toolsSpec.agentspaceAgentConfig.agent (full resource name)', assistUrl, {
    query: { text: PROBE },
    toolsSpec: { agentspaceAgentConfig: { agent: match.name } },
  }, saToken);

  await tryShape('Shape B: top-level "agent" (full resource name)', assistUrl, {
    query: { text: PROBE },
    agent: match.name,
  }, saToken);

  await tryShape('Shape C: no agent field at all (plain assistant default)', assistUrl, {
    query: { text: PROBE },
  }, saToken);

  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
