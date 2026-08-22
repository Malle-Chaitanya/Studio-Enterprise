/** Does the sharingConfig=ALL_USERS PATCH also fail on a private low-code agent, or is
 *  only the per-user/group setIamPolicy path blocked? This determines whether a
 *  restricted-source-sharing low-code agent has ANY way to grant chat access at all.
 *   npx tsx src/spikes/_diag_test_sharingconfig_on_private.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import type { GeminiDestination } from '../services/gemini.js';

const AGENT_ID = '1069171216929544881'; // Knowledge Assistant, from the same run, untouched by the last test
const dest: GeminiDestination = { project: 'studio-enterprise-migration', engine: 'geminienterpriseapp_1787403755425', assistant: 'default_assistant' };

function agentUrl(id: string) {
  return `https://discoveryengine.googleapis.com/v1alpha/projects/${dest.project}/locations/global/collections/default_collection/engines/${dest.engine}/assistants/${dest.assistant}/agents/${id}`;
}

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  console.log('--- BEFORE ---');
  const before = await fetch(agentUrl(AGENT_ID), { headers: { Authorization: `Bearer ${token}` } });
  const beforeBody = await before.json() as any;
  console.log(before.status, 'state:', beforeBody.state, 'sharingConfig:', JSON.stringify(beforeBody.sharingConfig ?? '(unset)'));

  console.log('\n--- Attempting sharingConfig=ALL_USERS on this PRIVATE low-code agent ---');
  const patch = await fetch(`${agentUrl(AGENT_ID)}?updateMask=sharingConfig`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sharingConfig: { scope: 'ALL_USERS' } }),
  });
  console.log(patch.status, await patch.text());

  console.log('\n--- AFTER ---');
  const after = await fetch(agentUrl(AGENT_ID), { headers: { Authorization: `Bearer ${token}` } });
  const afterBody = await after.json() as any;
  console.log(after.status, 'state:', afterBody.state, 'sharingConfig:', JSON.stringify(afterBody.sharingConfig ?? '(unset)'));
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
