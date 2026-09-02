/** Are shares actually readable via the fallback today? Settles the stale readError. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
await connectMongo();
const d = getDb();
const s = await d.collection('migrationSessions').find({}).sort({_id:-1}).limit(1).next() as any;
const rows = await d.collection('agentIRCache').find({ 'ir.permissions': { $exists: true } }).limit(6).toArray() as any[];
const envUrl: string = rows[0].envUrl;
const token = await clientCredsToken(s.tenantId, envUrl);
const H = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
let withShares = 0;
for (const r of rows) {
  const q = `principalobjectaccessset?$filter=objectid eq ${r.sourceId}&$select=principalid,accessrightsmask,objecttypecode`;
  const res = await fetch(`${envUrl}/api/data/v9.2/${q}`, { headers: H });
  const b = await res.json() as any;
  const n = (b.value ?? []).length;
  if (n) withShares++;
  console.log(`${String(res.status).padEnd(4)} ${(r.ir.name ?? '').padEnd(30)} shares=${n}` +
    (n ? `  first=${JSON.stringify(b.value[0])}` : ''));
}
console.log(`\n${withShares}/${rows.length} agents returned share rows`);
// And the group ids the chatAccess policy points at
const g = await fetch(`${envUrl}/api/data/v9.2/bots(${rows[0].sourceId})?$select=authorizedsecuritygroupids,accesscontrolpolicy`, { headers: H });
console.log(`\nbot access fields: ${JSON.stringify(await g.json())}`);
process.exit(0);
