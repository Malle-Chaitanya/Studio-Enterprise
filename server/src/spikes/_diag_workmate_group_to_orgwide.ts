/** Removes the group grant on WorkMate, then sets sharingConfig=ALL_USERS — completing
 *  the individual -> group -> org-wide sequence on the same real agent.
 *   npx tsx src/spikes/_diag_workmate_group_to_orgwide.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { shareAgent, assistantBase, type GeminiDestination } from '../services/gemini.js';

const AGENT_ID = '8561021016517220454';
const dest: GeminiDestination = { project: 'studio-enterprise-migration', engine: 'geminienterpriseapp_1787403755425', assistant: 'default_assistant' };
const agentUrl = `${assistantBase(dest)}/agents/${AGENT_ID}`;

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  console.log('--- BEFORE ---');
  const before = await fetch(`${agentUrl}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  const beforeBody = await before.json() as { bindings?: { role: string; members: string[] }[]; etag?: string };
  console.log(JSON.stringify(beforeBody, null, 2));

  console.log('\n--- Removing the group grant ---');
  const bindings = (beforeBody.bindings ?? []).map((b) =>
    b.role === 'roles/discoveryengine.agentUser'
      ? { ...b, members: b.members.filter((m) => m !== 'group:geminitestgroup@storefuze.com') }
      : b,
  );
  const removeRes = await fetch(`${agentUrl}:setIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy: { bindings, etag: beforeBody.etag } }),
  });
  console.log(removeRes.status, await removeRes.text());

  console.log('\n--- Setting sharingConfig=ALL_USERS ---');
  const shared = await shareAgent(dest, token, AGENT_ID);
  console.log('shareAgent() ->', shared);

  console.log('\n--- AFTER: full state ---');
  const after = await fetch(agentUrl, { headers: { Authorization: `Bearer ${token}` } });
  const afterBody = await after.json() as any;
  console.log('sharingConfig:', JSON.stringify(afterBody.sharingConfig));
  const afterIam = await fetch(`${agentUrl}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('IAM policy:', await afterIam.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
