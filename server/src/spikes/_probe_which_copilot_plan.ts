/** The 52 in the grid hold the CCIBOTSPROD family — but via WHICH plan? Closes 52 vs 8 vs 16. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { graphTokenFromRefresh, listGraphUsersFiltered } from '../auth/microsoft.js';
await connectMongo();
const s = await getDb().collection('migrationSessions').find({}).sort({_id:-1}).limit(1).next() as any;
const token = await graphTokenFromRefresh(s.tenantId, s.refreshToken);
const H = { Authorization: `Bearer ${token!}`, Accept: 'application/json' };
const { users } = await listGraphUsersFiltered(token!, { max: 200 });
console.log(`grid users: ${users.length}`);
const tally = new Map<string, number>();
const skuTally = new Map<string, number>();
let checked = 0;
for (const u of users) {
  const r = await fetch(`https://graph.microsoft.com/v1.0/users/${u.id}/licenseDetails`, { headers: H });
  if (!r.ok) continue;
  const b = await r.json() as any;
  checked++;
  for (const d of b.value ?? []) {
    for (const sp of d.servicePlans ?? []) {
      const n = sp.servicePlanName ?? '';
      if (/CCIBOTS|COPILOT_STUDIO|VIRTUAL_AGENT/i.test(n) && sp.provisioningStatus === 'Success') {
        tally.set(n, (tally.get(n) ?? 0) + 1);
        skuTally.set(`${d.skuPartNumber} -> ${n}`, (skuTally.get(`${d.skuPartNumber} -> ${n}`) ?? 0) + 1);
      }
    }
  }
}
console.log(`checked: ${checked}\n\n-- which plan grants Copilot Studio, by user count --`);
for (const [n, c] of [...tally].sort((a,b)=>b[1]-a[1])) console.log(`  ${String(c).padStart(3)}  ${n}`);
console.log(`\n-- via which SKU --`);
for (const [n, c] of [...skuTally].sort((a,b)=>b[1]-a[1])) console.log(`  ${String(c).padStart(3)}  ${n}`);
process.exit(0);
