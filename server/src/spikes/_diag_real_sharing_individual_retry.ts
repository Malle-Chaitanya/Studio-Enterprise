/** Retry of the individual-share leg of _diag_real_sharing_via_code.ts with the CURRENT
 *  "Teams Coordinator" agent id (the previous id, 3490661072028616401, no longer exists —
 *  confirmed via 404 on getIamPolicy and a fresh _diag_agents.ts listing showing the agent
 *  now lives at 18100528233420232026).
 *   npx tsx src/spikes/_diag_real_sharing_individual_retry.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase, ensureAgentAccess } from '../services/gemini.js';

const TEAMS_COORDINATOR = '18100528233420232026';
const INDIVIDUAL_USER = 'austin@fuzebot.co';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined;
  const token = await getSaToken(impersonate);
  const dest = await resolveDestination('studio-enterprise-migration', token);
  const base = assistantBase(dest);
  const cacheCtx = { appUserId: 'diag-real-sharing-test', tenantId: s?.tenantId ?? 'diag' };

  console.log('########## INDIVIDUAL — Teams Coordinator (correct id) ##########');
  const before = await fetch(`${base}/agents/${TEAMS_COORDINATOR}`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('Agent exists check:', before.status, (await before.text()).slice(0, 300));

  console.log(`\nensureAgentAccess(users: ["${INDIVIDUAL_USER}"])`);
  const r1 = await ensureAgentAccess(dest, token, TEAMS_COORDINATOR, { users: [INDIVIDUAL_USER], groups: [] }, cacheCtx);
  console.log('Result:', JSON.stringify(r1, null, 2));

  const v1 = await fetch(`${base}/agents/${TEAMS_COORDINATOR}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('Verify getIamPolicy:', v1.status, await v1.text());

  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
