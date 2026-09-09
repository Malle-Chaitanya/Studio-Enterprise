/** Redo the role check correctly (previous script wrongly read erik@voohalu.co's role
 *  instead of erik@filefuze.co's, since both match the sloppy startswith('erik@') filter)
 *  AND check the APPLICATION USER's own role, since Dataverse app-only calls need the
 *  calling application itself to be a valid application user with its own privileges,
 *  separate from whichever user it impersonates via MSCRMCallerID.
 *  npx tsx src/spikes/_diag_recheck_erik_and_appuser.ts */
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

async function rolesFor(label: string, userId: string) {
  const rolesRes = await fetch(
    `${base}/systemusers(${userId})/systemuserroles_association?$select=roleid,name`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } },
  );
  console.log(`\nRoles for ${label} (${userId}):`, JSON.stringify(await rolesRes.json(), null, 2));
}

// erik@filefuze.co's EXACT id (from the prior query, second match) — no ambiguity this time.
await rolesFor('erik@filefuze.co', 'bc5e0f98-2619-f111-8341-6045bd07e2cb');

// The APPLICATION USER: the app registration itself (client_id-based identity), which
// Dataverse tracks as its own systemuser row of type "Application User" — separate from
// any human it impersonates. Find it via applicationid on systemusers.
const clientId = process.env.MS_CLIENT_ID;
console.log('\nMS_CLIENT_ID from env:', clientId);
if (clientId) {
  const appRes = await fetch(
    `${base}/systemusers?$select=systemuserid,applicationid,fullname,internalemailaddress&$filter=${encodeURIComponent(`applicationid eq ${clientId}`)}`,
    { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } },
  );
  const appJson = (await appRes.json()) as { value?: { systemuserid: string }[] };
  console.log('\nApplication user matching MS_CLIENT_ID:', JSON.stringify(appJson.value, null, 2));
  if (appJson.value?.length) {
    await rolesFor('the application user (this tool\'s own app registration)', appJson.value[0].systemuserid);
  }
}

// Also: try the actual query the tool makes, AS the app-only token (no impersonation),
// to see the RAW error Dataverse gives for cr88d_clientcreditfacilities.
console.log('\n--- Direct app-only query to cr88d_clientcreditfacilities (no impersonation) ---');
const directRes = await fetch(
  `${base}/cr88d_clientcreditfacilities?$top=1`,
  { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'OData-MaxVersion': '4.0', 'OData-Version': '4.0' } },
);
console.log('status:', directRes.status);
console.log((await directRes.text()).slice(0, 1000));

// And WITH impersonation as erik@filefuze.co (MSCRMCallerID), matching exactly what the
// deployed tool does at runtime.
console.log('\n--- Same query WITH MSCRMCallerID: erik@filefuze.co\'s systemuserid ---');
const impersonatedRes = await fetch(
  `${base}/cr88d_clientcreditfacilities?$top=1`,
  {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'OData-MaxVersion': '4.0',
      'OData-Version': '4.0',
      MSCRMCallerID: 'bc5e0f98-2619-f111-8341-6045bd07e2cb',
    },
  },
);
console.log('status:', impersonatedRes.status);
console.log((await impersonatedRes.text()).slice(0, 1000));

process.exit(0);
