import { clientCredsToken } from '../auth/microsoft.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const api = `${ORG}/api/data/v9.2`;
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
const r = await fetch(`${api}/privileges?$select=privilegeid,name&$filter=contains(name,'clientcredit')`, { headers: h });
const rows = (JSON.parse(await r.text()).value ?? []) as { name: string; privilegeid: string }[];
console.log('matching privileges:', rows.length);
for (const p of rows) console.log('  ', p.name, p.privilegeid);
