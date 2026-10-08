import { clientCredsToken } from '../auth/microsoft.js';
import { listBots, extractAgent } from '../services/dataverse.js';
import { writeFileSync } from 'node:fs';

const TENANT_ID = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const URL = 'https://org32322095.crm.dynamics.com';
const TARGETS = [
  { id: '91206676-c49f-f111-aaad-0022480b169d', file: 'credit_amendment.json' },
  { id: 'ca01dff9-279d-f111-b8de-0022480b19e9', file: 'work_intelligence.json' },
];

async function main() {
  const token = await clientCredsToken(TENANT_ID, URL);
  const bots = await listBots(URL, token);
  for (const t of TARGETS) {
    const bot = bots.find((b) => b.botid === t.id);
    if (!bot) { console.error('bot not found', t.id); continue; }
    const ir = await extractAgent(URL, token, bot);
    writeFileSync(t.file, JSON.stringify(ir, null, 2));
    console.log(`wrote ${t.file}: topics=${ir.topics.length} knowledgeSources=${ir.knowledgeSources.length} agentTools=${(ir.agentTools||[]).length} flows=${(ir.flows||[]).length}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
