/**
 * Exactly which Dataverse reads are denied to our application user, and with what message.
 *
 * "Grant more access" is not an actionable ask. This names the specific call, the specific
 * status, and Dataverse's own error text, so an admin can map it to a privilege.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

await connectMongo();
const d = getDb();
const s = await d.collection('migrationSessions').find({}).sort({_id:-1}).limit(1).next() as any;
const staged = await d.collection('agentIRCache').findOne({ 'ir.permissions': { $exists: true } }) as any;
const envUrl: string = staged?.envUrl ?? s.environments?.[0]?.url;
const botId: string = staged?.sourceId;
console.log(`env: ${envUrl}\nbot: ${botId} (${staged?.ir?.name})\n`);

const token = await clientCredsToken(s.tenantId, envUrl);
const H = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

async function probe(label: string, path: string) {
  const r = await fetch(`${envUrl}/api/data/v9.2/${path}`, { headers: H });
  let detail = '';
  try { const b = await r.json() as any; detail = b?.error?.message ?? ''; } catch { /* not json */ }
  console.log(`${r.ok ? 'OK  ' : 'FAIL'} ${String(r.status).padEnd(4)} ${label}`);
  if (!r.ok) console.log(`       ${detail.slice(0, 260)}`);
  return r.ok;
}

console.log('--- what the permissions read needs ---');
await probe('bots row (baseline, known good)',
  `bots(${botId})?$select=_ownerid_value,accesscontrolpolicy,authorizedsecuritygroupids`);
await probe('RetrieveSharedPrincipalsAndAccess (the shares call)',
  `bots(${botId})/Microsoft.Dynamics.CRM.RetrieveSharedPrincipalsAndAccess()`);
await probe('principalobjectaccessset (fallback)',
  `principalobjectaccessset?$filter=objectid eq ${botId}&$select=principalid,accessrightsmask`);
await probe('systemusers (owner resolution)',
  'systemusers?$top=1&$select=systemuserid,internalemailaddress,fullname');
await probe('teams (team-owned agents)', 'teams?$top=1&$select=teamid,name');
await probe('roles (what our app user holds)', 'roles?$top=3&$select=name');

console.log('\n--- who are we, and what roles do we have? ---');
const who = await fetch(`${envUrl}/api/data/v9.2/WhoAmI`, { headers: H });
const me = await who.json() as any;
console.log(`WhoAmI: ${who.status}  userid=${me.UserId ?? '-'}`);
if (me.UserId) {
  const r = await fetch(
    `${envUrl}/api/data/v9.2/systemusers(${me.UserId})?$select=fullname,applicationid` +
    `&$expand=systemuserroles_association($select=name)`, { headers: H });
  const b = await r.json() as any;
  console.log(`app user: ${b.fullname ?? '-'}  appId=${b.applicationid ?? '-'}`);
  const roles = (b.systemuserroles_association ?? []).map((x: any) => x.name);
  console.log(`roles (${roles.length}): ${roles.join(', ') || '(none)'}`);
}
process.exit(0);
