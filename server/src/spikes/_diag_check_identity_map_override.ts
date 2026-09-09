/** Find the identity-map override for admin@migrationn.com -> its source Microsoft email,
 *  then check THAT email's Dataverse systemuser + security roles.
 *  npx tsx src/spikes/_diag_check_identity_map_override.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
import type { Session } from '../sessionStore.js';

await connectMongo();
const db = getDb('csge');

const maps = await db.collection('identityMappings').find({}).sort({ $natural: -1 }).limit(3).toArray();
for (const m of maps) {
  console.log(JSON.stringify(m, null, 2).slice(0, 3000));
  console.log('---');
}

const s = (await db
  .collection('migrationSessions')
  .find({ tenantId: { $exists: true }, dvOrgUrl: { $exists: true } })
  .sort({ $natural: -1 })
  .limit(1)
  .next()) as Session | null;
if (!s?.tenantId || !s.dvOrgUrl) throw new Error('NO_USABLE_SESSION');
const token = await clientCredsToken(s.tenantId, s.dvOrgUrl);
const base = `${s.dvOrgUrl.replace(/\/$/, '')}/api/data/v9.2`;

// Find the mapped source email for admin@migrationn.com, if any.
let sourceEmail: string | undefined;
for (const m of maps) {
  const overrides = (m as any).users ?? (m as any).userOverrides ?? [];
  for (const o of overrides) {
    const dest = (o.destEmail || o.destinationEmail || o.google || o.dest || '').toLowerCase();
    if (dest === 'admin@migrationn.com') {
      sourceEmail = o.sourceEmail || o.source || o.ms || o.microsoft;
    }
  }
}
console.log('\nResolved source email for admin@migrationn.com:', sourceEmail ?? '(none found in override list above — check shape printed)');

if (sourceEmail) {
  const local = sourceEmail.split('@')[0];
  const flt = `internalemailaddress eq '${sourceEmail}' or domainname eq '${sourceEmail}' or startswith(internalemailaddress,'${local}@')`;
  const res = await fetch(
    `${base}/systemusers?$select=systemuserid,internalemailaddress,fullname&$top=5&$filter=${encodeURIComponent(flt)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } },
  );
  const json = (await res.json()) as { value?: { systemuserid: string; internalemailaddress: string; fullname: string }[] };
  console.log('\nsystemusers matching', sourceEmail, ':', JSON.stringify(json.value, null, 2));
  if (json.value?.length === 1) {
    const uid = json.value[0].systemuserid;
    const rolesRes = await fetch(
      `${base}/systemusers(${uid})/systemuserroles_association?$select=roleid,name`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } },
    );
    console.log('\nSecurity roles:', JSON.stringify(await rolesRes.json(), null, 2));
  }
}
process.exit(0);
