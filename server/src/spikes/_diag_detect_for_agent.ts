/** What does OUR connector detection see for one agent? Throwaway. */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { detectKnowledgeConnectors } from '../services/knowledgeConnectorScan.js';
import { detectThirdPartyConnectors } from '../services/thirdPartyConnectorScan.js';
import { listBots } from '../services/dataverse.js';

const ENV = process.argv[2]!, BOT = process.argv[3]!;
const mc = await MongoClient.connect(config.MONGO_HOST);
const cached = await mc.db(config.CSGE_DB).collection('environmentsCache')
  .find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next() as any;
await mc.close();
const token = await clientCredsToken(cached.tenantId, ENV);
const names = new Map((await listBots(ENV, token)).map((b: any) => [b.botid, b.name]));

console.log('=== detectKnowledgeConnectors (componenttype 16 + 9) ===');
for (const c of await detectKnowledgeConnectors(ENV, token, [BOT], names)) {
  console.log(`  ${c.connectorId}  confidence=${(c as any).confidence}  supported=${c.def ? 'yes' : 'NO'}  unsupported=${(c as any).unsupported ?? false}`);
  console.log(`     operations=${JSON.stringify((c as any).operations ?? [])}`);
}
console.log('\n=== detectThirdPartyConnectors (Power Automate flows, env-wide) ===');
for (const c of await detectThirdPartyConnectors(ENV, token)) {
  console.log(`  ${c.connectorId}  flows=${c.flowCount}  unsupported=${(c as any).unsupported ?? false}`);
}
process.exit(0);
