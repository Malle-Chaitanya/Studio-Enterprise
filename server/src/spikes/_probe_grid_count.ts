/** What does the Map users grid ACTUALLY get, with the config as it stands right now? */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { graphTokenFromRefresh, listGraphUsersFiltered } from '../auth/microsoft.js';
import { config } from '../config.js';
await connectMongo();
const s = await getDb().collection('migrationSessions').find({}).sort({_id:-1}).limit(1).next() as any;
const token = await graphTokenFromRefresh(s.tenantId, s.refreshToken);
if (!token) throw new Error('no graph token');
console.log(`MS_REQUIRED_SERVICE_PLANS = ${JSON.stringify(config.MS_REQUIRED_SERVICE_PLANS)}`);
console.log(`DIRECTORY_LICENSED_ONLY   = ${config.DIRECTORY_LICENSED_ONLY}`);
// Exactly what routes/identity.ts /ms-users does with all=absent.
const filtered = await listGraphUsersFiltered(token, { max: 200 });
const unfiltered = await listGraphUsersFiltered(token, { max: 999, licensedOnly: false });
console.log(`\ngrid (filtered)  : ${filtered.users.length}`);
console.log(`stats            : ${JSON.stringify(filtered.stats)}`);
console.log(`unfiltered total : ${unfiltered.users.length}`);
const nonCopilot = filtered.users.filter(u => !(u.servicePlans ?? []).some(p => p.includes('CCIBOTSPROD')));
console.log(`\nIN THE GRID WITHOUT CCIBOTSPROD: ${nonCopilot.length}`);
for (const u of nonCopilot.slice(0, 8)) console.log(`  ${u.email}  plans=${(u.servicePlans ?? []).join(',').slice(0,90)}`);
process.exit(0);
