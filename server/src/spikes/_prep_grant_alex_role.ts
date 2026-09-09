/**
 * Grant ONE Dataverse security role to ONE user. Read-only by default in the sense that it
 * adds a role and never removes one — and it prints the exact DELETE to revert.
 *
 * WHY THIS EXISTS. `alex@filefuze.co` holds only Environment Maker, which carries no read
 * privilege on `cr88d_clientcreditfacility`, so an impersonated read returns 403 while
 * `erik@filefuze.co` (System Administrator) returns rows. That contrast is the proof that
 * MSCRMCallerID impersonation applies the CALLER's roles rather than the application's —
 * capture it with _probe_dv_as_user.ts BEFORE running this, because granting removes it.
 *
 *   npx tsx src/spikes/_prep_grant_alex_role.ts
 *   USER_EMAIL=someone@x.co ROLE='Support User' npx tsx src/spikes/_prep_grant_alex_role.ts
 *
 * Roles that grant read on that table in this environment (least privilege first):
 *   Service Reader, Support User, Service Writer, System Customizer, System Administrator
 */
import { clientCredsToken } from '../auth/microsoft.js';

const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const USER = process.env.USER_EMAIL || 'alex@filefuze.co';
const ROLE = process.env.ROLE || 'Service Reader';

const token = await clientCredsToken('807d6772-847c-40e2-9bec-e2c930b3a42e', ORG);
const api = `${ORG}/api/data/v9.2`;
const h = {
  Authorization: `Bearer ${token}`,
  Accept: 'application/json',
  'Content-Type': 'application/json',
};

const ur = await fetch(
  `${api}/systemusers?$select=systemuserid,_businessunitid_value&$filter=internalemailaddress eq '${USER}'`,
  { headers: h },
);
const u = (JSON.parse(await ur.text()).value ?? [])[0] as
  | { systemuserid: string; _businessunitid_value: string }
  | undefined;
if (!u) {
  console.log(`${USER}: not a systemuser in this environment`);
  process.exit(1);
}

// A role exists once PER BUSINESS UNIT. Associating the copy from another BU fails or grants
// nothing useful, so match the user's own BU rather than taking the first name match.
const rr = await fetch(
  `${api}/roles?$select=roleid,name&$filter=name eq '${ROLE}' and _businessunitid_value eq ${u._businessunitid_value}`,
  { headers: h },
);
const roles = (JSON.parse(await rr.text()).value ?? []) as { roleid: string; name: string }[];
if (!roles.length) {
  console.log(`role "${ROLE}" not found in this user's business unit`);
  process.exit(1);
}
const roleId = roles[0].roleid;

const res = await fetch(`${api}/systemusers(${u.systemuserid})/systemuserroles_association/$ref`, {
  method: 'POST',
  headers: h,
  body: JSON.stringify({ '@odata.id': `${api}/roles(${roleId})` }),
});

if (res.ok) {
  console.log(`GRANTED "${ROLE}" to ${USER}`);
} else {
  console.log(`FAILED ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
console.log(
  `to revert: DELETE ${api}/systemusers(${u.systemuserid})/systemuserroles_association/${roleId}/$ref`,
);
