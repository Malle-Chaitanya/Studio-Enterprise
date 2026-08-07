/** Two-tier detection across every agent in an environment: which hits are structural
 *  (certain) and which are inferred from editable text (heuristic).
 *  npx tsx src/spikes/_test_two_tier_detection.ts [envUrl] */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import { detectKnowledgeConnectors } from '../services/knowledgeConnectorScan.js';
import type { Session } from '../sessionStore.js';
const ENV = process.argv[2] ?? 'https://orga243378d.crm.dynamics.com';
await connectMongo();
const s = (await getDb().collection('migrationSessions').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next()) as Session | null;
const token = await clientCredsToken(s!.tenantId!, ENV);
const bots = await listBots(ENV, token);
const names = new Map(bots.map((b) => [b.botid, b.name]));
const found = await detectKnowledgeConnectors(ENV, token, bots.map((b) => b.botid), names);
console.log(`${found.length} connector(s) across ${bots.length} agent(s)\n`);
for (const c of found) {
  console.log(`  ${c.connectorId}  [${c.confidence}]  sources=${c.flowCount}`);
  console.log(`     agents : ${(c.agentNames ?? []).join(', ') || '(unattributed)'}`);
  console.log(`     from   : ${c.flowNames.slice(0, 3).join(' | ')}`);
}
process.exit(0);
