import { clientCredsToken } from '../auth/microsoft.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const token = await clientCredsToken(TENANT, ORG);
const api = `${ORG}/api/data/v9.2`;

for (const who of ['erik@filefuze.co', 'alex@filefuze.co']) {
  const r = await fetch(
    `${api}/systemusers?$select=systemuserid,fullname,isdisabled&$filter=internalemailaddress eq '${who}'`
    + `&$expand=systemuserroles_association($select=name)`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  const rows = (JSON.parse(await r.text()).value ?? []) as { systemuserid: string; fullname: string; isdisabled: boolean; systemuserroles_association?: { name: string }[] }[];
  if (!rows.length) { console.log(`${who.padEnd(20)} NOT a Dataverse systemuser at all`); continue; }
  for (const u of rows) {
    const roles = (u.systemuserroles_association ?? []).map((x) => x.name);
    console.log(`${who.padEnd(20)} systemuser=yes disabled=${u.isdisabled} roles=${roles.length ? roles.join(', ') : '(NONE)'}`);
  }
}
