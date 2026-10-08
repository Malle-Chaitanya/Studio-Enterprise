/** List every bot whose name starts with "Deal Desk", with its botid. */
import { clientCredsToken } from '../auth/microsoft.js';

const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const r = await fetch(
  `${ORG}/api/data/v9.2/bots?$select=name,botid,modifiedon&$filter=statecode eq 0 and startswith(name,'Deal Desk')`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } },
);
const rows = (JSON.parse(await r.text()).value ?? []) as { name: string; botid: string; modifiedon: string }[];
if (!rows.length) console.log('no bot named "Deal Desk*"');
for (const b of rows) console.log(`${b.name.padEnd(16)} ${b.botid}  modified=${b.modifiedon}`);
