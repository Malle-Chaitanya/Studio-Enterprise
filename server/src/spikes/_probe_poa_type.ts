import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';
await connectMongo();
const d = getDb();
const s = await d.collection('migrationSessions').find({}).sort({_id:-1}).limit(1).next() as any;
const a = await d.collection('agentIRCache').findOne({ 'ir.permissions': { $exists: true } }) as any;
const envUrl = a.envUrl; const token = await clientCredsToken(s.tenantId, envUrl);
const H = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
// full row, no $select — see every column the platform will give us
const r = await fetch(`${envUrl}/api/data/v9.2/principalobjectaccessset?$filter=objectid eq ${a.sourceId}`, { headers: H });
const rows = ((await r.json()) as any).value ?? [];
console.log(JSON.stringify(rows[0], null, 2));
const pid = rows[0]?.principalid;
if (pid) {
  for (const t of ['teams','systemusers','businessunits','fieldsecurityprofiles','bots']) {
    const res = await fetch(`${envUrl}/api/data/v9.2/${t}?$filter=${t === 'teams' ? 'teamid' : t === 'systemusers' ? 'systemuserid' : t === 'businessunits' ? 'businessunitid' : t === 'bots' ? 'botid' : 'fieldsecurityprofileid'} eq ${pid}`, { headers: H });
    const b = await res.json() as any;
    console.log(`${t}: ${res.status} count=${(b.value ?? []).length} ${(b.value?.[0] ? JSON.stringify(b.value[0]).slice(0,180) : '')}`);
  }
}
process.exit(0);
