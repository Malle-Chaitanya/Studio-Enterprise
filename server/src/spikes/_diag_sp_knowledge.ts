/**
 * What happens to a SharePoint knowledge source, as the PLANNER decides it?
 *
 * The assessment says "connector setup", but the orchestrator has a copy-mode path via
 * Microsoft Graph because Gemini's native SharePoint connector returns zero content
 * (ledger, knowledgeClassifier.ts). Those two must not disagree in front of a customer.
 *
 * Read-only.  npx tsx src/spikes/_diag_sp_knowledge.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, discoverEnvironments } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { assessAgent } from '../services/assess.js';

await connectMongo();
const cache = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const tenantId = cache!.tenantId!;

for (const env of await discoverEnvironments(tenantId)) {
  let token: string;
  let bots: Awaited<ReturnType<typeof listBots>>;
  try { token = await clientCredsToken(tenantId, env.url); bots = await listBots(env.url, token); } catch { continue; }
  for (const bot of bots) {
    const ir = await extractAgent(env.url, token, bot).catch(() => null);
    if (!ir) continue;
    const sp = (ir.knowledgeSources ?? []).filter((k) => /sharepoint/i.test(JSON.stringify(k).slice(0, 4000)));
    if (!sp.length) continue;
    console.log(`\n${ir.name}   [${env.name}]`);
    for (const k of sp) console.log(`    source: ${k.name}  kind=${k.kind}  strategy=${k.classification?.strategy ?? '?'} target=${k.classification?.target ?? '?'}`);
    for (const a of assessAgent(ir).knowledge?.actions ?? []) {
      console.log(`    plan:   [${a.disposition}] ${a.title} → ${a.strategy}/${a.target}`);
      console.log(`            ${a.detail.slice(0, 170)}`);
    }
  }
}
process.exit(0);
