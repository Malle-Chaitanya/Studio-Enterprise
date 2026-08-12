/** Which agents in an environment use which connectors? Read-only. */
import 'dotenv/config';
import { MongoClient } from 'mongodb';
import { config } from '../config.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots } from '../services/dataverse.js';
import { detectKnowledgeConnectors } from '../services/knowledgeConnectorScan.js';
const ENV = process.argv[2]!;
const mc = await MongoClient.connect(config.MONGO_HOST);
const cached = await mc.db(config.CSGE_DB).collection('environmentsCache').find({ tenantId: { $exists: true } }).sort({ $natural: -1 }).limit(1).next() as any;
await mc.close();
const token = await clientCredsToken(cached.tenantId, ENV);
const bots = await listBots(ENV, token) as any[];
const names = new Map(bots.map((b) => [b.botid, b.name]));
const found = await detectKnowledgeConnectors(ENV, token, bots.map((b) => b.botid), names);
const byAgent = new Map<string, string[]>();
for (const c of found as any[]) {
  for (const a of c.agentNames ?? []) {
    const list = byAgent.get(a) ?? [];
    list.push(`${c.connectorId}${c.unsupported ? ' (unsupported)' : ''}${c.operations?.length ? ' [' + c.operations.join(', ') + ']' : ''}`);
    byAgent.set(a, list);
  }
}
for (const [agent, conns] of [...byAgent].sort()) {
  console.log(`\n${agent}`);
  for (const c of conns) console.log(`   ${c}`);
}
process.exit(0);
