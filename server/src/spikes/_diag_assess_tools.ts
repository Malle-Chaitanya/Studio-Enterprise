/**
 * Does the pre-migration ASSESSMENT mention an agent's tools?
 *
 * The assessment is what the customer reads before committing to a migration. It listed
 * instructions, topics, knowledge and capabilities and no tools at all, so an agent whose
 * whole job was calling Jira could be assessed as trivially migratable. Print what the
 * Explore screen would now show.
 *
 * Read-only.
 *
 * npx tsx src/spikes/_diag_assess_tools.ts "AA"
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { assessAgent } from '../services/assess.js';

const needle = (process.argv[2] ?? '').toLowerCase();
await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    token = await clientCredsToken(tenantId, env.url);
    bots = await listBots(env.url, token);
  } catch {
    continue;
  }
  for (const bot of bots.filter((b) => b.name.toLowerCase().includes(needle))) {
    const ir = await extractAgent(env.url, token, bot).catch(() => null);
    if (!ir) continue;
    const a = assessAgent(ir);
    console.log(`\n══ ${env.name} · ${ir.name}   effort=${a.effort}   ${JSON.stringify(a.summary)}`);
    for (const c of a.components.filter((c) => c.kind.startsWith('tool'))) {
      console.log(`\n  [${c.compatibility}] ${c.component}   (${c.kind})`);
      console.log(`      ${c.note}`);
    }
    console.log(`\n  dependencies:`);
    for (const d of a.dependencies) console.log(`    ${d.type}: ${d.ref}  (from ${d.from})`);
  }
}
process.exit(0);
