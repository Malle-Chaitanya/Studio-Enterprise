import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { graphTokenFromRefresh, listGraphUsersFiltered } from '../auth/microsoft.js';
await connectMongo();
const s = await getDb().collection('migrationSessions').find({}).sort({_id:-1}).limit(1).next() as any;
const token = await graphTokenFromRefresh(s.tenantId, s.refreshToken);
const H = { Authorization: `Bearer ${token}`, Accept: 'application/json', ConsistencyLevel: 'eventual' };
const IDS: Record<string,string> = {
  COPILOT_STUDIO_IN_COPILOT_FOR_M365: 'fe6c28b3-d468-44ea-bbd0-a10a5167435c',
  CCIBOTS_PRIVPREV_VIRAL: 'ce312d15-8fdf-44c0-9974-a25a177125ee',
};
const q = async (f: string) => {
  const u = 'https://graph.microsoft.com/v1.0/users?$count=true&$top=999&$select=mail,userPrincipalName&$filter=' + encodeURIComponent(f);
  const r = await fetch(u, { headers: H });
  const b = await r.json() as any;
  return { status: r.status, n: (b.value ?? []).length,
    set: new Set((b.value ?? []).map((x:any)=>(x.mail ?? x.userPrincipalName ?? '').toLowerCase()).filter(Boolean)) };
};
const each: Record<string, Set<string>> = {};
for (const [name,id] of Object.entries(IDS)) {
  const r = await q(`assignedPlans/any(a:a/servicePlanId eq ${id} and a/capabilityStatus eq 'Enabled')`);
  each[name] = r.set;
  console.log(`${name}: ${r.status} -> ${r.n}`);
}
const both = await q(Object.values(IDS).map((id)=>`assignedPlans/any(a:a/servicePlanId eq ${id} and a/capabilityStatus eq 'Enabled')`).join(' or '));
console.log(`OR of both: ${both.status} -> ${both.n}`);
const { users } = await listGraphUsersFiltered(token!, { max: 999, licensedOnly: false });
const mem = new Set(users.filter(u=>(u.servicePlans??[]).some(p=>p.includes('CCIBOTSPROD'))).map(u=>u.email.toLowerCase()));
console.log(`in-memory CCIBOTSPROD family: ${mem.size}`);
const union = new Set([...Object.values(each).flatMap(x=>[...x])]);
console.log(`union of the two plans: ${union.size}`);
console.log(`in memory but in NEITHER plan: ${[...mem].filter(e=>!union.has(e)).length}`);
console.log(`sample missing: ${[...mem].filter(e=>!union.has(e)).slice(0,3).join(', ')}`);
process.exit(0);
