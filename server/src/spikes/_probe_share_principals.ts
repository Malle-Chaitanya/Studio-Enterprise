/** 75 share rows resolved to zero users. What ARE those principals? */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
await connectMongo();
const d = getDb();
const s = await d.collection('migrationSessions').find({}).sort({_id:-1}).limit(1).next() as any;
const a = await d.collection('agentIRCache').findOne({ 'ir.permissions': { $exists: true } }) as any;
const envUrl = a.envUrl;
const token = await clientCredsToken(s.tenantId, envUrl);
const H = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
const q = `principalobjectaccessset?$filter=objectid eq ${a.sourceId}&$select=principalid,accessrightsmask`;
const rows = ((await (await fetch(`${envUrl}/api/data/v9.2/${q}`, { headers: H })).json()) as any).value ?? [];
console.log(`bot: ${a.ir.name}  share rows: ${rows.length}`);
for (const r of rows) {
  const id = r.principalid;
  for (const [table, sel] of [['teams','teamid,name,teamtype,_azureactivedirectoryobjectid_value'],['systemusers','systemuserid,fullname,internalemailaddress']]) {
    const res = await fetch(`${envUrl}/api/data/v9.2/${table}(${id})?$select=${sel}`, { headers: H });
    if (res.ok) { console.log(`  ${id} -> ${table}: ${JSON.stringify(await res.json()).slice(0,260)}`); break; }
    else if (table === 'systemusers') console.log(`  ${id} -> not a team, not a systemuser (${res.status})`);
  }
}
// owner of an unresolved-owner agent
const un = await d.collection('agentIRCache').findOne({ 'ir.permissions.owner.email': { $exists: false }, 'ir.permissions.owner.id': { $exists: true } }) as any;
if (un) {
  const oid = un.ir.permissions.owner.id;
  console.log(`\nunresolved owner ${oid} on "${un.ir.name}"`);
  for (const [t, sel] of [['teams','teamid,name,teamtype'],['systemusers','systemuserid,fullname']]) {
    const res = await fetch(`${envUrl}/api/data/v9.2/${t}(${oid})?$select=${sel}`, { headers: H });
    console.log(`  ${t}: ${res.status} ${res.ok ? JSON.stringify(await res.json()).slice(0,200) : ''}`);
  }
}
process.exit(0);
