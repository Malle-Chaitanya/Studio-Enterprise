/** Tests the ACTUAL production sharing functions (not raw fetch) against three real,
 *  already-migrated ADK agents, one per sharing shape:
 *   1. Individual  — Teams Coordinator            (ensureAgentAccess, users: [...])
 *   2. Group       — SharePoint Connector Agent (ADK) (ensureAgentAccess, groups: [...])
 *   3. Org-wide    — CloudFuze Studio Migrate (full: docs + live + topics) (shareAgent)
 *  Verifies each afterward via getIamPolicy / raw GET, using the real gemini.ts code path
 *  end to end, exactly as orchestrator.ts would call it.
 *   npx tsx src/spikes/_diag_real_sharing_via_code.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase, ensureAgentAccess, shareAgent } from '../services/gemini.js';

const TEAMS_COORDINATOR = '3490661072028616401';
const SHAREPOINT_CONNECTOR_ADK = '8251121235349690669';
const CLOUDFUZE_STUDIO_MIGRATE_FULL = '1326005160808304638';
const INDIVIDUAL_USER = 'austin@fuzebot.co';
const GROUP = 'geminitestgroup@storefuze.com';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const impersonate = process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined;
  const token = await getSaToken(impersonate);
  const dest = await resolveDestination('studio-enterprise-migration', token);
  const base = assistantBase(dest);
  const cacheCtx = { appUserId: 'diag-real-sharing-test', tenantId: s?.tenantId ?? 'diag' };

  console.log('########## 1. INDIVIDUAL — Teams Coordinator ##########');
  console.log(`ensureAgentAccess(users: ["${INDIVIDUAL_USER}"])`);
  const r1 = await ensureAgentAccess(dest, token, TEAMS_COORDINATOR, { users: [INDIVIDUAL_USER], groups: [] }, cacheCtx);
  console.log('Result:', JSON.stringify(r1, null, 2));
  const v1 = await fetch(`${base}/agents/${TEAMS_COORDINATOR}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('Verify getIamPolicy:', await v1.text());

  console.log('\n########## 2. GROUP — SharePoint Connector Agent (ADK) ##########');
  console.log(`ensureAgentAccess(groups: ["${GROUP}"])`);
  const r2 = await ensureAgentAccess(dest, token, SHAREPOINT_CONNECTOR_ADK, { users: [], groups: [GROUP] }, cacheCtx);
  console.log('Result:', JSON.stringify(r2, null, 2));
  const v2 = await fetch(`${base}/agents/${SHAREPOINT_CONNECTOR_ADK}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('Verify getIamPolicy:', await v2.text());

  console.log('\n########## 3. ORG-WIDE — CloudFuze Studio Migrate (full: docs + live + topics) ##########');
  console.log('shareAgent() -> sharingConfig PATCH');
  const r3 = await shareAgent(dest, token, CLOUDFUZE_STUDIO_MIGRATE_FULL);
  console.log('shareAgent() returned:', r3);
  const v3 = await fetch(`${base}/agents/${CLOUDFUZE_STUDIO_MIGRATE_FULL}`, { headers: { Authorization: `Bearer ${token}` } });
  console.log('Verify raw agent body:', await v3.text());

  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
