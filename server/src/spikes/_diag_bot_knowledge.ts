/** Knowledge sources for a bot, straight from extraction. Read-only. */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
const ENV = process.argv[2]!, BOT = process.argv[3]!;
const mc = await MongoClient.connect(config.MONGO_HOST);
const cached = await mc.db(config.CSGE_DB).collection('environmentsCache').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next() as any;
await mc.close();
const token = await clientCredsToken(cached.tenantId, ENV);
const bot = (await listBots(ENV, token)).find((b: any) => b.botid === BOT)!;
const ir = await extractAgent(ENV, token, bot);
console.log(`${ir.name}: instr=${ir.instructions.length}ch  desc=${ir.description.length}ch  knowledge=${ir.knowledgeSources.length}`);
for (const k of ir.knowledgeSources) {
  console.log(`  - ${k.kind} "${k.name}"`);
  console.log(`      strategy=${k.classification?.strategy ?? '-'} automatable=${k.classification?.automatable}`);
}
console.log(`  unmapped: ${ir.unmapped.length}`);
process.exit(0);
