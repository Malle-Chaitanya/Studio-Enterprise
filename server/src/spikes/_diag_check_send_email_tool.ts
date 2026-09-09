import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getCachedIR } from '../db/repos/agentIR.js';

const APP_USER_ID = '6a5dfdff7cf05623332758b7';
const ENV_URL = 'https://org32322095.crm.dynamics.com';
const SOURCE_ID = '91206676-c49f-f111-aaad-0022480b169d';

await connectMongo();
const cached = await getCachedIR(APP_USER_ID, ENV_URL, SOURCE_ID);
if (!cached) throw new Error('NO_CACHED_IR');

console.log('=== agentTools ===');
for (const t of cached.ir.agentTools ?? []) {
  console.log(`- name="${t.name}" displayName="${t.displayName ?? ''}" kind=${t.kind} connectorId=${t.connectorId ?? ''} operationId=${t.operationId ?? ''} childAgentTopicId=${t.childAgentTopicId ?? ''}`);
}
console.log('\n=== flows ===');
for (const f of cached.ir.flows ?? []) {
  console.log(`- ${f.name} (${f.actions.length} actions): ${f.actions.map(a => a.type).join(', ')}`);
}
process.exit(0);
