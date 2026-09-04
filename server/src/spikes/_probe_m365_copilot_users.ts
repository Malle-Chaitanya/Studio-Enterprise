/** Who exactly holds the paid M365 Copilot seat (COPILOT_STUDIO_IN_COPILOT_FOR_M365)? */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { graphTokenFromRefresh } from '../auth/microsoft.js';
await connectMongo();
const s = await getDb().collection('migrationSessions').find({}).sort({_id:-1}).limit(1).next() as any;
const token = await graphTokenFromRefresh(s.tenantId, s.refreshToken);
const H = { Authorization: `Bearer ${token}`, Accept: 'application/json', ConsistencyLevel: 'eventual' };
const f = "assignedPlans/any(a:a/servicePlanId eq fe6c28b3-d468-44ea-bbd0-a10a5167435c and a/capabilityStatus eq 'Enabled')";
const u = 'https://graph.microsoft.com/v1.0/users?$count=true&$top=999&$select=displayName,mail,userPrincipalName,accountEnabled&$filter=' + encodeURIComponent(f);
const b = await (await fetch(u, { headers: H })).json() as any;
for (const x of b.value ?? []) {
  console.log(`  ${(x.displayName ?? '-').padEnd(20)} ${(x.mail ?? x.userPrincipalName ?? '-').padEnd(34)} enabled=${x.accountEnabled}`);
}
console.log(`total: ${(b.value ?? []).length}`);
process.exit(0);
