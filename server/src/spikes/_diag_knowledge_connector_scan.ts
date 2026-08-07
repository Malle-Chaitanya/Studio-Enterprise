/** Does detectKnowledgeConnectors surface Confluence for a given agent?
 *  npx tsx src/spikes/_diag_knowledge_connector_scan.ts <envUrl> <botId...> */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { detectKnowledgeConnectors } from '../services/knowledgeConnectorScan.js';
import { listBots } from '../services/dataverse.js';
import type { Session } from '../sessionStore.js';

const ENV = process.argv[2] ?? 'https://org32322095.crm.dynamics.com';
let botIds = process.argv.slice(3);
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await clientCredsToken(s!.tenantId!, ENV);

if (botIds.length === 0) {
  const bots = await listBots(ENV, token);
  const hit = bots.filter((b) => /confluence/i.test(b.name));
  console.log(`agents matching "confluence" in ${ENV}: ${hit.map((b) => `${b.name} [${b.botid}]`).join(', ') || '(none)'}`);
  botIds = hit.map((b) => b.botid);
}
if (botIds.length === 0) { console.log('nothing to scan'); process.exit(0); }

const found = await detectKnowledgeConnectors(ENV, token, botIds);
console.log(`\ndetectKnowledgeConnectors -> ${found.length} connector(s)`);
for (const c of found) console.log(`  ${c.connectorId}  (${c.def?.name ?? 'no def'})  flows=${c.flowCount}  ${c.flowNames.join(', ')}`);
process.exit(0);
