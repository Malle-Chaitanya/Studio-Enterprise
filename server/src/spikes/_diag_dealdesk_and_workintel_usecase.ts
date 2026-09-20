/** Fetch the "Deal Desk" and "Work Intelligence & Enablement Agent" bots straight from
 *  the Copilot Studio (Dataverse) source and dump their description + instructions +
 *  topic names, so we can state what each agent actually does.
 *  npx tsx src/spikes/_diag_dealdesk_and_workintel_usecase.ts */
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

console.log(`Total bots in tenant: ${bots.length}`);
console.log('All bot names:');
for (const b of bots) console.log(`  - ${b.name}`);

const targets = ['dealdesk', 'deal desk 2', 'work intelligence & enablement agent', 'work intelligence and enablement agent'];
for (const wanted of targets) {
  const bot = bots.find((b) => b.name.trim().toLowerCase() === wanted);
  if (!bot) continue;
  console.log(`\n${'='.repeat(80)}`);
  console.log(`AGENT: ${bot.name}`);
  console.log('='.repeat(80));
  const ir = await extractAgent(s.dvOrgUrl, token, bot);
  console.log(`\n-- description --\n${ir.description || '(none)'}`);
  console.log(`\n-- instructions --\n${ir.instructions || '(none)'}`);
  console.log(`\n-- topics (${ir.topics?.length ?? 0}) --`);
  for (const t of ir.topics ?? []) {
    console.log(`  - "${t.name}" isSystem=${t.isSystem}${t.modelDescription ? ` :: ${t.modelDescription}` : ''}`);
  }
  console.log(`\n-- knowledge sources (${ir.knowledgeSources?.length ?? 0}) --`);
  for (const k of ir.knowledgeSources ?? []) {
    console.log(`  - ${JSON.stringify(k).slice(0, 200)}`);
  }
}

process.exit(0);
