import { clientCredsToken } from '../auth/microsoft.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const TABLE = process.env.TABLE || 'cr88d_clientcreditfacilities';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const api = `${ORG}/api/data/v9.2`;
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

// The read privilege for a table is named prvRead<logicalname>.
const priv = `prvRead${TABLE}`;
const pr = await fetch(`${api}/privileges?$select=privilegeid,name&$filter=name eq '${priv}'`, { headers: h });
const privs = (JSON.parse(await pr.text()).value ?? []) as { privilegeid: string; name: string }[];
if (!privs.length) { console.log(`no privilege named ${priv} — check the table logical name`); process.exit(0); }
console.log(`privilege: ${privs[0].name}`);

// Which security roles hold it?
const rp = await fetch(
  `${api}/roleprivileges?$select=privilegedepthmask&$filter=privilegeid eq ${privs[0].privilegeid}&$expand=roleid($select=name)`,
  { headers: h });
const txt = await rp.text();
if (!rp.ok) { console.log('roleprivileges query failed', rp.status, txt.slice(0, 300)); process.exit(0); }
const rows = (JSON.parse(txt).value ?? []) as { privilegedepthmask: number; roleid?: { name?: string } }[];
const depth: Record<number, string> = { 1: 'User', 2: 'BusinessUnit', 4: 'Parent:Child BU', 8: 'Organization' };
console.log(`roles granting read on ${TABLE}:`);
for (const r of rows) console.log(`   ${(r.roleid?.name ?? '?').padEnd(38)} depth=${depth[r.privilegedepthmask] ?? r.privilegedepthmask}`);
