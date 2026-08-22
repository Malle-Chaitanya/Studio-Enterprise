/** Tests whether publishing a low-code agent (a separate action from its state field)
 *  changes whether Google accepts setIamPolicy on it — the agent currently fails with
 *  "Cannot set IAM policy on a private agent" even though :publish doesn't flip `state`
 *  from PRIVATE to ENABLED (confirmed earlier). If publish unlocks the IAM call anyway,
 *  that resolves the whole ADK-vs-low-code dilemma without needing either workaround.
 *   npx tsx src/spikes/_diag_test_publish_then_iam.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase, publishAgent, grantAgentAccess } from '../services/gemini.js';

const AGENT_ID = '3299875621167969112'; // Migrate Advisor, from this run's log

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const dest = await resolveDestination('studio-enterprise-migration', token);
  const base = assistantBase(dest);

  console.log('--- BEFORE: raw agent state ---');
  const before = await fetch(`${base}/agents/${AGENT_ID}`, { headers: { Authorization: `Bearer ${token}` } });
  const beforeBody = await before.json() as any;
  console.log('state:', beforeBody.state, ' activeRevision:', beforeBody.activeRevision, ' lowCodeAgentDefinition keys:', Object.keys(beforeBody.lowCodeAgentDefinition ?? {}));

  console.log('\n--- Publishing it ---');
  const published = await publishAgent(dest, token, AGENT_ID);
  console.log('publishAgent() ->', published);

  console.log('\n--- AFTER publish: raw agent state ---');
  const after = await fetch(`${base}/agents/${AGENT_ID}`, { headers: { Authorization: `Bearer ${token}` } });
  const afterBody = await after.json() as any;
  console.log('state:', afterBody.state, ' activeRevision:', afterBody.activeRevision);

  console.log('\n--- Retrying grantAgentAccess after publish ---');
  const grant = await grantAgentAccess(dest, token, AGENT_ID, { users: ['austin@fuzebot.co'], groups: [] });
  console.log('grantAgentAccess() ->', JSON.stringify(grant, null, 2));

  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
