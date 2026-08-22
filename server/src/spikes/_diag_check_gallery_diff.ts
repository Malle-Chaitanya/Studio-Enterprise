/** Austin sees Employee Onboarding, KB-Grounding-Test, Teams Coordinator in "From your
 *  organization" — Collins doesn't. Both see Email Manager (Outlook), CloudFuze Studio,
 *  Hubspot agentt, SharePoint Connector, "A" (Migration Advisor). Checking each agent's
 *  real definitionType, state, sharingConfig, and per-agent IAM policy to find the
 *  actual difference, instead of guessing.
 *   npx tsx src/spikes/_diag_check_gallery_diff.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const dest = await resolveDestination('studio-enterprise-migration', token);
  const base = assistantBase(dest);

  const listRes = await fetch(`${base}/agents?pageSize=200`, { headers: { Authorization: `Bearer ${token}` } });
  const listBody = await listRes.json() as { agents?: any[] };
  const names = ['Employee Onboarding', 'KB-Grounding-Test', 'Teams Coordinator', 'Email Manager', 'CloudFuze Studio', 'Hubspot agentt', 'SharePoint Connector', 'CloudFuze Migration Advisor'];

  for (const namePart of names) {
    const match = (listBody.agents ?? []).find((a) => (a.displayName ?? '').includes(namePart));
    if (!match) { console.log(`\n=== "${namePart}" — NOT FOUND ===`); continue; }
    const id = match.name.split('/').pop();
    console.log(`\n=== "${match.displayName}" (${id}) ===`);
    console.log('type:', match.adkAgentDefinition ? 'ADK' : match.lowCodeAgentDefinition ? 'LOW-CODE' : 'UNKNOWN', ' state:', match.state, ' sharingConfig:', JSON.stringify(match.sharingConfig ?? '(unset)'));
    const iamRes = await fetch(`${base}/agents/${id}:getIamPolicy`, { headers: { Authorization: `Bearer ${token}` } });
    console.log('IAM policy:', await iamRes.text());
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
