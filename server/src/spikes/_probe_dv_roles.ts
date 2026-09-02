/** Which Dataverse users actually HAVE roles? Read-only. */
import { clientCredsToken } from '../auth/microsoft.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const TENANT = '807d6772-847c-40e2-9bec-e2c930b3a42e';
const token = await clientCredsToken(TENANT, ORG);
const api = `${ORG}/api/data/v9.2`;
const get = async (p: string) => {
  const r = await fetch(`${api}${p}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
  return { ok: r.ok, status: r.status, body: await r.text() };
};
const u = await get("/systemusers?$select=systemuserid,fullname,internalemailaddress&$filter=isdisabled eq false&$expand=systemuserroles_association($select=name)&$top=25");
if (!u.ok) { console.log('ERR', u.status, u.body.slice(0, 200)); process.exit(1); }
for (const r of (JSON.parse(u.body).value ?? []) as any[]) {
  const roles = (r.systemuserroles_association ?? []).map((x: any) => x.name);
  if (!roles.length) continue;
  console.log(`${(r.internalemailaddress ?? r.fullname).padEnd(42)} ${roles.slice(0,4).join(', ')}`);
}
