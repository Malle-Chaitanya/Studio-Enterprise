/**
 * Which service plans do this tenant's users actually hold?
 *
 * Decides MS_REQUIRED_SERVICE_PLANS from data instead of from a guessed SKU string. A wrong
 * guess hides real people from the mapping grid and is indistinguishable from those people
 * not existing, so the plan name has to be READ, not assumed.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { graphTokenFromRefresh, listGraphUsersFiltered } from '../auth/microsoft.js';

await connectMongo();
const s = await getDb().collection('migrationSessions').find({}).sort({ _id: -1 }).limit(1).next() as any;
const token = await graphTokenFromRefresh(s.tenantId, s.refreshToken);
if (!token) throw new Error('no graph token');

const { users } = await listGraphUsersFiltered(token, { max: 999, licensedOnly: false });
const count = new Map<string, number>();
for (const u of users) for (const p of u.servicePlans ?? []) count.set(p, (count.get(p) ?? 0) + 1);

console.log(`active users: ${users.length}`);
console.log('\n-- plans mentioning copilot / virtual agent / power --');
for (const [p, n] of [...count].sort((a, b) => b[1] - a[1])) {
  if (/COPILOT|VIRTUAL_AGENT|CCIBOTS|POWERAPPS|FLOW|POWER/i.test(p)) console.log(`  ${String(n).padStart(4)}  ${p}`);
}
console.log('\n-- top 15 plans overall --');
for (const [p, n] of [...count].sort((a, b) => b[1] - a[1]).slice(0, 15)) console.log(`  ${String(n).padStart(4)}  ${p}`);
console.log(`\ndistinct plans: ${count.size}`);
process.exit(0);
