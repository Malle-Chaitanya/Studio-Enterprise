/** Does extraction now capture the agent's tools (componenttype 9 TaskDialogs)? Throwaway. */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

const ENV = process.argv[2]!, BOT = process.argv[3]!;
const mc = await MongoClient.connect(config.MONGO_HOST);
const cached = await mc.db(config.CSGE_DB).collection('environmentsCache')
  .find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next() as any;
await mc.close();
const token = await clientCredsToken(cached.tenantId, ENV);
const bot = (await listBots(ENV, token)).find((b: any) => b.botid === BOT)!;
const ir = await extractAgent(ENV, token, bot);
console.log(`agent: ${ir.name}`);
console.log(`topics: ${ir.topics.length}   agentTools: ${ir.agentTools?.length ?? 0}\n`);
for (const t of ir.agentTools ?? []) {
  console.log(`- [${t.kind}] ${t.name}`);
  console.log(`    connector=${t.connectorId ?? '-'}  operation=${t.operationId ?? '-'}`);
  if (t.description) console.log(`    desc=${t.description.slice(0, 90)}`);
  if (t.outputs) console.log(`    outputs=${t.outputs.join(', ')}`);
}
console.log('\ntopics kept:');
for (const t of ir.topics) console.log(`  - ${t.name}${t.isSystem ? ' (system)' : ''}`);
process.exit(0);
