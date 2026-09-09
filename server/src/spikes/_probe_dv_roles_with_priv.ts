import { clientCredsToken } from '../auth/microsoft.js';
const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const PRIV = process.env.PRIV || 'prvReadcr88d_clientcreditfacility';
const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const api = `${ORG}/api/data/v9.2`;
const h = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

// RetrieveRolesForPrivilege isn't exposed; walk roles and expand their privileges instead.
const rr = await fetch(`${api}/roles?$select=roleid,name&$top=200`, { headers: h });
const roles = (JSON.parse(await rr.text()).value ?? []) as { roleid: string; name: string }[];
console.log(`checking ${roles.length} roles for ${PRIV} ...`);
const hits: string[] = [];
for (const role of roles) {
  const p = await fetch(
    `${api}/roles(${role.roleid})/roleprivileges_association?$select=name&$filter=name eq '${PRIV}'`,
    { headers: h });
  if (!p.ok) continue;
  const got = (JSON.parse(await p.text()).value ?? []) as unknown[];
  if (got.length) hits.push(role.name);
}
console.log(hits.length ? 'roles granting it:' : 'NO role grants it');
for (const n of [...new Set(hits)].sort()) console.log('   -', n);
