/** Every Copilot agent in the environment, so a capability probe targets the right one. */
import { clientCredsToken } from '../auth/microsoft.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const r = await fetch(`${ORG}/api/data/v9.2/bots?$select=botid,name,modifiedon&$filter=statecode eq 0`, {
  headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
});
const bots = (JSON.parse(await r.text()).value ?? []) as { botid: string; name: string; modifiedon: string }[];
bots.sort((a, b) => String(b.modifiedon).localeCompare(String(a.modifiedon)));
console.log(`${bots.length} agent(s):`);
for (const b of bots) console.log(`  ${String(b.name).padEnd(28)} ${b.botid}  ${String(b.modifiedon).slice(0, 10)}`);
process.exit(0);
