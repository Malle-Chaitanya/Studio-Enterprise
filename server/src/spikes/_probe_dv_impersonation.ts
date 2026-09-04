/**
 * Does app-only Dataverse + MSCRMCallerID actually ACT AS another user?
 *
 * This decides the architecture. If it works, a migrated agent can serve each person
 * their own data using ONE stored credential — no per-user consent, nothing to expire,
 * and it keeps working after this tool is removed. If it does not, per-user OAuth
 * consent stays the only path and the durability problem stays with it.
 *
 * Read-only: WhoAmI plus a row count. Nothing is written.
 */
import { clientCredsToken } from '../auth/microsoft.js';

const ORG = process.env.DV_ORG || 'https://org32322095.crm.dynamics.com';
const TENANT = process.env.MS_TENANT_ID || '807d6772-847c-40e2-9bec-e2c930b3a42e';

const token = await clientCredsToken(TENANT, ORG);
const api = `${ORG}/api/data/v9.2`;

async function call(path: string, callerId?: string, header = 'MSCRMCallerID') {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    'OData-MaxVersion': '4.0', 'OData-Version': '4.0',
  };
  if (callerId) headers[header] = callerId;
  const r = await fetch(`${api}${path}`, { headers });
  const body = await r.text();
  return { ok: r.ok, status: r.status, body };
}

// 1. Who is the APPLICATION user?
const who = await call('/WhoAmI');
console.log('WhoAmI (app-only):', who.status, who.body.slice(0, 220));
if (!who.ok) { console.log('\nApp-only Dataverse access is not working — cannot test impersonation.'); process.exit(1); }
const appUserId = JSON.parse(who.body).UserId as string;

// 2. Find real users to impersonate.
const users = await call("/systemusers?$select=systemuserid,fullname,internalemailaddress,isdisabled&$filter=isdisabled eq false&$top=8");
if (!users.ok) { console.log('systemusers failed:', users.status, users.body.slice(0, 200)); process.exit(1); }
const rows = (JSON.parse(users.body).value ?? []) as Array<{ systemuserid: string; fullname: string; internalemailaddress?: string }>;
console.log(`\nactive users: ${rows.length}`);
for (const u of rows) console.log(`  ${u.fullname}  ${u.internalemailaddress ?? '-'}  ${u.systemuserid}`);

// A REAL person, not a service principal: '#'-prefixed and *@onmicrosoft/dynamics.com
// rows are platform application users with no privileges of their own, so impersonating
// one proves nothing except that it has no rights.
const target = rows.find((u) =>
  u.systemuserid !== appUserId
  && !u.fullname.startsWith('#')
  && /@filefuze\.co$/i.test(u.internalemailaddress ?? ''));
if (!target) { console.log('no other user to impersonate'); process.exit(1); }

// 3. THE TEST: same call, with the caller header. If Dataverse honours it, WhoAmI
//    comes back as the OTHER person rather than the application.
console.log(`\n--- impersonating ${target.fullname} (${target.systemuserid}) ---`);
for (const header of ['MSCRMCallerID', 'CallerObjectId']) {
  const imp = await call('/WhoAmI', target.systemuserid, header);
  if (!imp.ok) { console.log(`${header}: ${imp.status} ${imp.body.slice(0, 260)}`); continue; }
  const got = JSON.parse(imp.body).UserId as string;
  const worked = got.toLowerCase() === target.systemuserid.toLowerCase();
  console.log(`${header}: ${imp.status}  UserId=${got}  ${worked ? 'IMPERSONATION WORKS' : 'IGNORED (still the app user)'}`);
}

// 4. Does visibility actually differ? Row counts the app sees vs the user sees.
const asApp = await call('/accounts?$select=name&$top=50');
const asUser = await call('/accounts?$select=name&$top=50', target.systemuserid);
const n = (r: { ok: boolean; body: string }) => (r.ok ? (JSON.parse(r.body).value ?? []).length : `ERR ${r.body.slice(0, 80)}`);
console.log(`\naccounts visible — app: ${n(asApp)}   as ${target.fullname}: ${n(asUser)}`);
