/** Do this agent's flows WRITE anything, or only read? A demo that says "increase the credit
 *  limit" needs a real write somewhere; the agent's own tool list shows only Dataverse
 *  "List rows", so the flows are the only remaining candidate. Read-only inspection. */
import { clientCredsToken } from '../auth/microsoft.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const BOT = process.env.BOT || '91206676-c49f-f111-aaad-0022480b169d';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

// The agent's flow-backed tools reference workflows by id; pull every cloud flow in the
// environment and match by name, which is what the agent's tool names use.
const wr = await fetch(
  `${ORG}/api/data/v9.2/workflows?$select=name,clientdata,category,statecode&$filter=category eq 5`,
  { headers: h },
);
const flows = (JSON.parse(await wr.text()).value ?? []) as { name: string; clientdata?: string }[];
const WANT = (process.env.FLOWS || 'GetRateSheetBand,DraftFollwUpEMail,GenerateAmendmentDocument,Postoteams')
  .split(',').map((s) => s.trim().toLowerCase());

// Power Automate action kinds that CHANGE data, as they appear in a flow's clientdata.
const WRITE_OPS = [
  'UpdateRecord', 'CreateRecord', 'DeleteRecord', 'UpdateItem', 'PatchItem',
  'PostItem', 'SendEmailV2', 'UpdateOnlyItem', 'ExecuteChangeset',
];
for (const f of flows) {
  if (!WANT.includes((f.name ?? '').toLowerCase())) continue;
  const d = `${f.clientdata ?? ''}`;
  const found = WRITE_OPS.filter((op) => d.includes(op));
  const conns = [...new Set(d.match(/shared_[a-zA-Z0-9_-]+/g) ?? [])];
  const ops = [...new Set(d.match(/"operationId":\s*"([^"]+)"/g) ?? [])]
    .map((s) => s.replace(/.*"operationId":\s*"/, '').replace(/"$/, ''));
  console.log(`\n## ${f.name}`);
  console.log(`   connectors : ${conns.join(', ') || '(none)'}`);
  console.log(`   operations : ${ops.join(', ') || '(none)'}`);
  console.log(`   WRITES     : ${found.length ? found.join(', ') : 'none found — read only'}`);
}
process.exit(0);
