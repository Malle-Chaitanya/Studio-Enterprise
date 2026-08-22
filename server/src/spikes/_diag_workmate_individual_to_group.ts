/** Removes austin's individual Agent User grant on WorkMate, then grants
 *  geminitestgroup@storefuze.com (which has both austin and collins as members,
 *  from yesterday's group test) instead — testing the group-share shape on WorkMate.
 *   npx tsx src/spikes/_diag_workmate_individual_to_group.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { ensureAgentAccess, assistantBase, type GeminiDestination } from '../services/gemini.js';

const AGENT_ID = '8561021016517220454';
const dest: GeminiDestination = { project: 'studio-enterprise-migration', engine: 'geminienterpriseapp_1787403755425', assistant: 'default_assistant' };
const agentUrl = `${assistantBase(dest)}/agents/${AGENT_ID}`;

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  console.log('--- BEFORE: current IAM policy ---');
  const before = await fetch(`${agentUrl}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  const beforeBody = await before.json() as { bindings?: { role: string; members: string[] }[]; etag?: string };
  console.log(JSON.stringify(beforeBody, null, 2));

  console.log('\n--- Removing austin@fuzebot.co from the agentUser binding ---');
  const bindings = (beforeBody.bindings ?? []).map((b) =>
    b.role === 'roles/discoveryengine.agentUser'
      ? { ...b, members: b.members.filter((m) => m !== 'user:austin@fuzebot.co') }
      : b,
  );
  const removeRes = await fetch(`${agentUrl}:setIamPolicy`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ policy: { bindings, etag: beforeBody.etag } }),
  });
  console.log(removeRes.status, await removeRes.text());

  console.log('\n--- Granting the group geminitestgroup@storefuze.com instead ---');
  const grant = await ensureAgentAccess(dest, token, AGENT_ID, { users: [], groups: ['geminitestgroup@storefuze.com'] }, { appUserId: 'diag-workmate-group', tenantId: 'diag' });
  console.log(JSON.stringify(grant, null, 2));

  console.log('\n--- AFTER: final IAM policy ---');
  const after = await fetch(`${agentUrl}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(await after.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
