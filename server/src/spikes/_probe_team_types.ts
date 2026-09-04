/** teamtype: 0=Owner (Dataverse plumbing) 1=Access 2=AAD Security Group 3=AAD Office Group */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
await connectMongo();
const d = getDb();
const s = await d.collection('migrationSessions').find({}).sort({_id:-1}).limit(1).next() as any;
const agents = await d.collection('agentIRCache').find({ 'ir.permissions': { $exists: true } })
  .project({ envUrl:1, sourceId:1, 'ir.name':1, _id:0 }).toArray() as any[];
const byEnv = new Map<string, any[]>();
for (const a of agents) (byEnv.get(a.envUrl) ?? byEnv.set(a.envUrl, []).get(a.envUrl)!).push(a);
const LABEL: Record<number,string> = {0:'Owner team (plumbing)',1:'Access team',2:'AAD SECURITY GROUP',3:'AAD Office group'};
const tally = new Map<string, number>(); const aadGroups = new Set<string>();
for (const [envUrl, list] of byEnv) {
  const token = await clientCredsToken(s.tenantId, envUrl);
  const H = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  const tj = await (await fetch(`${envUrl}/api/data/v9.2/teams?$select=teamid,name,teamtype,_azureactivedirectoryobjectid_value&$top=5000`, { headers: H })).json() as any;
  const teams = new Map<string, any>((tj.value ?? []).map((t: any) => [String(t.teamid).toLowerCase(), t]));
  for (const a of list) {
    const rows = ((await (await fetch(`${envUrl}/api/data/v9.2/principalobjectaccessset?$filter=objectid eq ${a.sourceId}&$select=principalid,principaltypecode`, { headers: H })).json()) as any).value ?? [];
    for (const r of rows) {
      if (r.principaltypecode !== 'team') { tally.set(`principal: ${r.principaltypecode}`, (tally.get(`principal: ${r.principaltypecode}`) ?? 0)+1); continue; }
      const t = teams.get(String(r.principalid).toLowerCase());
      const k = t ? LABEL[t.teamtype] ?? `teamtype ${t.teamtype}` : 'team not found';
      tally.set(k, (tally.get(k) ?? 0) + 1);
      if (t && (t.teamtype === 2 || t.teamtype === 3)) aadGroups.add(`${t.name} (aad=${t._azureactivedirectoryobjectid_value ?? '-'})`);
    }
  }
}
console.log('\n--- what the share rows actually are ---');
for (const [k,v] of [...tally].sort((a,b)=>b[1]-a[1])) console.log(`  ${String(v).padStart(3)}  ${k}`);
console.log(`\nreal AAD groups with access: ${aadGroups.size}`);
for (const g of aadGroups) console.log(`  ${g}`);
process.exit(0);
