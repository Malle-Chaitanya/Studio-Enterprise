/** Runs the real ensureAgentAccess() flow for austin@fuzebot.co on WorkMate:
 *  1. checkUserLicense — if not licensed, report and stop.
 *  2. If licensed, ensureAgentAccess proceeds: engine role -> per-agent Agent User grant.
 *  Reports each step's real result, not a summary.
 *   npx tsx src/spikes/_diag_share_workmate.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { checkUserLicense, ensureAgentAccess, assistantBase, type GeminiDestination } from '../services/gemini.js';

const AGENT_ID = '8561021016517220454';
const dest: GeminiDestination = { project: 'studio-enterprise-migration', engine: 'geminienterpriseapp_1787403755425', assistant: 'default_assistant' };
const USER = 'austin@fuzebot.co';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);

  console.log(`--- Step 1: is ${USER} a licensed Gemini Enterprise user? ---`);
  const license = await checkUserLicense(dest, token, USER);
  console.log('License state:', license);
  if (license === 'unlicensed') {
    console.log(`\n${USER} is NOT licensed. Reporting and stopping here, per your instruction — no grant attempted.`);
    process.exit(0);
  }
  if (license === 'unknown') {
    console.log('\nLicense state came back unknown (transient check failure) — proceeding anyway per this codebase\'s existing policy: never block a real grant attempt on an unverified guess.');
  }

  console.log(`\n--- Step 2+3: ensureAgentAccess (engine role -> per-agent Agent User) for ${USER} on WorkMate ---`);
  const result = await ensureAgentAccess(dest, token, AGENT_ID, { users: [USER], groups: [] }, { appUserId: 'diag-workmate-share', tenantId: 'diag' });
  console.log(JSON.stringify(result, null, 2));

  console.log('\n--- Verify: real IAM policy on WorkMate now ---');
  const iamRes = await fetch(`${assistantBase(dest)}/agents/${AGENT_ID}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log(await iamRes.text());
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
