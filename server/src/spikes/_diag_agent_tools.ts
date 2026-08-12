/** What tools does extractAgent actually produce for an agent? Read-only. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';

const ENV = process.argv[3] ?? 'https://org32322095.crm.dynamics.com';
const NAME = process.argv[2] ?? 'Case Management';
await connectMongo();
const row = (await getDb().collection('environmentsCache').find({ tenantId: { $exists: true } })
  .sort({ $natural: -1 }).limit(1).next()) as { tenantId?: string } | null;
const token = await clientCredsToken(row!.tenantId!, ENV);
const bots = await listBots(ENV, token);
for (const bot of bots.filter((b) => b.name.toLowerCase().includes(NAME.toLowerCase()))) {
  const ir = await extractAgent(ENV, token, bot);
  console.log(`\n### ${bot.name} — ${(ir.agentTools ?? []).length} tool(s)`);
  for (const t of ir.agentTools ?? []) {
    console.log(`  ${t.kind.padEnd(16)} conn=${t.connectorId ?? '-'} op=${t.operationId ?? '-'} inputs=${t.inputs?.length ?? 0} name="${t.name}"`);
  }
}
process.exit(0);
