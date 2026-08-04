/**
 * Diagnose the missing-deployedNodes bug: call :publish again on the broken
 * "CloudFuze Studio Migrate" agent and print the RAW response body (our
 * production code only checks res.ok, discarding the body — this shows us
 * what Google actually said). Then re-fetch the agent to see if
 * deployedNodes/deployedRootAgentId appeared.
 *
 *   npx tsx src/spikes/_diag_republish_check.ts
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
  const agentsJson = (await agentsRes.json()) as { agents?: { name?: string; displayName?: string }[] };
  const match = (agentsJson.agents ?? []).find((a) => (a.displayName ?? '').toLowerCase().includes('cloudfuze studio migrate'));
  if (!match?.name) throw new Error('agent not found');
  const agentId = match.name.split('/').pop()!;
  console.log(`agent: ${match.displayName}  agentId=${agentId}`);

  const publishUrl = `${assistantBase(dest)}/agents/${agentId}:publish`;
  console.log(`\nPOST ${publishUrl}`);
  const pubRes = await fetch(publishUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  const pubText = await pubRes.text();
  console.log(`status: ${pubRes.status}`);
  console.log(`body: ${pubText.slice(0, 2000)}`);

  console.log('\n--- re-fetching agent to check for deployedNodes ---');
  const getRes = await fetch(`${assistantBase(dest)}/agents/${agentId}`, { headers: { Authorization: `Bearer ${saToken}` } });
  const agent = (await getRes.json()) as Record<string, unknown>;
  const def = agent.lowCodeAgentDefinition as Record<string, unknown> | undefined;
  console.log(`state: ${agent.state}`);
  console.log(`has deployedNodes: ${!!def?.deployedNodes}`);
  console.log(`has deployedRootAgentId: ${!!def?.deployedRootAgentId}`);
  console.log(`lowCodeAgentDefinition keys: ${def ? Object.keys(def).join(', ') : '(none)'}`);

  process.exit(0);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
