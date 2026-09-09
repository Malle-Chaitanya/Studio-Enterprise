/** Dump the Deal Desk agent's full instructions text and per-topic tool bindings, to check
 *  whether "GetClientProfile from HubSpot" / client-info retrieval is a real wired
 *  capability or just prose in the agent's own instructions.
 *  npx tsx src/spikes/_diag_dealdesk_instructions_and_topics.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const s = (await getDb()
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true }, dvOrgUrl: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;
if (!s?.tenantId || !s.dvOrgUrl) throw new Error('NO_USABLE_SESSION');
const token = await clientCredsToken(s.tenantId, s.dvOrgUrl);
const bots = await listBots(s.dvOrgUrl, token);
const bot = bots.find((b) => b.name.trim().toLowerCase() === 'deal desk');
if (!bot) throw new Error('Deal Desk not found');
const ir = await extractAgent(s.dvOrgUrl, token, bot);

console.log('=== FULL INSTRUCTIONS ===');
console.log(ir.instructions ?? '(none)');

console.log('\n=== TOPICS mentioning client/profile/hubspot ===');
for (const t of ir.topics ?? []) {
  const hay = JSON.stringify(t).toLowerCase();
  if (hay.includes('hubspot') || hay.includes('client') || hay.includes('profile')) {
    console.log(`- topic "${t.name}" isSystem=${t.isSystem}`);
    console.log(`  modelDescription: ${t.modelDescription ?? '-'}`);
  }
}

console.log('\n=== connectors referenced anywhere in raw IR (search for hubspot) ===');
const full = JSON.stringify(ir).toLowerCase();
console.log('mentions "hubspot":', full.includes('hubspot'));
console.log('mentions "clientinfo":', full.includes('clientinfo'));
console.log('mentions "getclientprofile":', (full.includes('getclientprofile')));
process.exit(0);
