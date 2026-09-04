/**
 * Which Graph APPLICATION permissions is the Outlook connector's app actually granted?
 *
 * Reads (Mail.Read/Mail.ReadWrite) are proven live. Sending is a SEPARATE grant: app-only
 * POST /users/{id}/sendMail needs Mail.Send, and without it every write fails 403 at run
 * time -- which reads as a code bug rather than a missing consent. Checking here costs one
 * read; discovering it from a failed live send costs a migration.
 */
import 'dotenv/config';

const tenant = process.env.MS_GRAPH_TENANT_ID!;
const clientId = process.env.MS_GRAPH_CLIENT_ID!;
const secret = process.env.MS_GRAPH_CLIENT_SECRET!;

const tok = (await (await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId, client_secret: secret,
    scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials',
  }),
})).json()) as { access_token?: string; error_description?: string };

if (!tok.access_token) { console.log('TOKEN FAILED:', tok.error_description); process.exit(1); }
const h = { Authorization: `Bearer ${tok.access_token}` };

const sp = (await (await fetch(
  `https://graph.microsoft.com/v1.0/servicePrincipals?$filter=appId eq '${clientId}'&$select=id,displayName`,
  { headers: h })).json()) as { value?: { id: string; displayName: string }[] };
const me = sp.value?.[0];
if (!me) { console.log('no service principal for this appId'); process.exit(1); }
console.log('app:', me.displayName);

const asgRes = await fetch(
  `https://graph.microsoft.com/v1.0/servicePrincipals/${me.id}/appRoleAssignments?$top=999`,
  { headers: h });
const asgBody = await asgRes.text();
if (!asgRes.ok) {
  // An error here is NOT "no permissions granted" -- reading one's own role assignments
  // needs Application.Read.All, so a 403 means the probe cannot see, not that the grant
  // is absent. Reporting those as MISSING is how a working connector looks broken.
  console.log(`CANNOT READ role assignments (${asgRes.status}): ${asgBody.slice(0, 300)}`);
  process.exit(2);
}
const asg = JSON.parse(asgBody) as { value?: { resourceId: string; appRoleId: string; resourceDisplayName: string }[] };
console.log(`role assignments returned: ${asg.value?.length ?? 0}`);

// Resolve role ids -> names via the resource SP that publishes them.
const byResource = new Map<string, string[]>();
for (const a of asg.value ?? []) {
  byResource.set(a.resourceId, [...(byResource.get(a.resourceId) ?? []), a.appRoleId]);
}
const granted: string[] = [];
for (const [resourceId, roleIds] of byResource) {
  const rr = await fetch(
    `https://graph.microsoft.com/v1.0/servicePrincipals/${resourceId}?$select=displayName,appRoles`,
    { headers: h });
  if (!rr.ok) {
    console.log(`  cannot resolve resource ${resourceId} (${rr.status}) - ${roleIds.length} role(s) unnamed`);
    continue;
  }
  const res = (await rr.json()) as { displayName?: string; appRoles?: { id: string; value: string }[] };
  for (const id of roleIds) {
    const r = res.appRoles?.find((x) => x.id === id);
    granted.push(r ? `${res.displayName}: ${r.value}` : `${res.displayName}: <unknown role ${id}>`);
  }
}
granted.sort();
for (const g of granted) console.log('  ' + g);

for (const need of ['Mail.Read', 'Mail.ReadWrite', 'Mail.Send']) {
  const has = granted.some((g) => g.endsWith(': ' + need));
  console.log(`${has ? 'GRANTED ' : 'MISSING '} ${need}`);
}
