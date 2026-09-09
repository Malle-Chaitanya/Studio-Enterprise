/** Check erik@filefuze.co's Dataverse systemuser + security roles — this is the REAL
 *  impersonated identity for admin@migrationn.com per identityMappings (source->dest,
 *  inverted at deploy time), the caller behind the live 403 on cr88d_clientcreditfacilities.
 *  npx tsx src/spikes/_diag_check_erik_dataverse_roles.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const db = getDb('csge');
const s = (await db
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true }, dvOrgUrl: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;
if (!s?.tenantId || !s.dvOrgUrl) throw new Error('NO_USABLE_SESSION');
const token = await clientCredsToken(s.tenantId, s.dvOrgUrl);
const base = `${s.dvOrgUrl.replace(/\/$/, '')}/api/data/v9.2`;

const CALLER = 'erik@filefuze.co';
const local = CALLER.split('@')[0];
const flt = `internalemailaddress eq '${CALLER}' or domainname eq '${CALLER}' or startswith(internalemailaddress,'${local}@')`;
const res = await fetch(
  `${base}/systemusers?$select=systemuserid,internalemailaddress,fullname&$top=5&$filter=${encodeURIComponent(flt)}`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } },
);
const json = (await res.json()) as { value?: { systemuserid: string; internalemailaddress: string; fullname: string }[] };
console.log('systemusers matching', CALLER, ':', JSON.stringify(json.value, null, 2));

if (json.value?.length) {
  const uid = json.value[0].systemuserid;
  const rolesRes = await fetch(
    `${base}/systemusers(${uid})/systemuserroles_association?$select=roleid,name`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } },
  );
  const rolesJson = await rolesRes.json();
  console.log('\nSecurity roles for', CALLER, ':', JSON.stringify(rolesJson, null, 2));
}
process.exit(0);
