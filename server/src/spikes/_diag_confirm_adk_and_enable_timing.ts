/** Confirms: (1) all three tested agents are genuinely ADK (adkAgentDefinition +
 *  a real provisionedReasoningEngine), not low-code, and (2) state:ENABLED and
 *  createTime predate today's sharing test — i.e. they were already enabled by
 *  the original migration/ADK-registration, not flipped ENABLED by our sharing
 *  calls just now.
 *   npx tsx src/spikes/_diag_confirm_adk_and_enable_timing.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import type { Session } from '../sessionStore.js';
import { getSaToken } from '../auth/google.js';
import { resolveDestination, assistantBase } from '../services/gemini.js';

const AGENTS: Record<string, string> = {
  'Teams Coordinator': '18100528233420232026',
  'SharePoint Connector Agent (ADK)': '8251121235349690669',
  'CloudFuze Studio Migrate (full: docs + live + topics)': '1326005160808304638',
};

async function main() {
  await connectMongo();
  const s = (await getDb().collection('migrationSessions').find({}).sort({ $natural: -1 }).limit(1).next()) as Session | null;
  const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || s?.gEmail || undefined);
  const dest = await resolveDestination('studio-enterprise-migration', token);

  for (const [name, id] of Object.entries(AGENTS)) {
    const res = await fetch(`${assistantBase(dest)}/agents/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await res.json() as any;
    console.log(`\n=== ${name} (${id}) ===`);
    console.log('definitionType:', body.adkAgentDefinition ? 'ADK' : body.lowCodeAgentDefinition ? 'LOW-CODE' : 'UNKNOWN');
    console.log('reasoningEngine:', body.adkAgentDefinition?.provisionedReasoningEngine?.reasoningEngine ?? '(none)');
    console.log('state:', body.state);
    console.log('createTime:', body.createTime);
    console.log('updateTime:', body.updateTime);
    console.log('sharingConfig:', JSON.stringify(body.sharingConfig ?? '(unset)'));
  }
  process.exit(0);
}
main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
