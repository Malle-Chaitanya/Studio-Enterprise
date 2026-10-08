/** Every Dataverse security role currently held by a user. */
import { clientCredsToken } from '../auth/microsoft.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const WHO = process.env.WHO || 'alex@filefuze.co,erik@filefuze.co';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const api = `${ORG}/api/data/v9.2`;
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
for (const who of WHO.split(',').map((s) => s.trim())) {
  const u = await fetch(`${api}/systemusers?$select=systemuserid&$filter=internalemailaddress eq '${who}'`, { headers: h });
  const id = (JSON.parse(await u.text()).value ?? [])[0]?.systemuserid;
  if (!id) { console.log(`${who}: not a systemuser`); continue; }
  const r = await fetch(`${api}/systemusers(${id})/systemuserroles_association?$select=name,roleid`, { headers: h });
  const roles = (JSON.parse(await r.text()).value ?? []) as { name: string; roleid: string }[];
  console.log(`${who}  (${id})`);
  for (const x of roles) console.log(`    ${x.name}   roleid=${x.roleid}`);
}
process.exit(0);
