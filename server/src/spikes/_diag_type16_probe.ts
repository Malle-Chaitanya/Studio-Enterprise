/** Ask Dataverse for EVERY botcomponent on this bot, no statecode filter, and show type 16. */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken, tenantIdFromToken } from '../auth/microsoft.js';

const botId = process.argv[2];
await connectMongo();
const s = await getDb().collection('migrationSessions').find({}).sort({ _id: -1 }).limit(1).next() as any;
const staged = await getDb().collection('stagedAgents').find({ sourceId: botId }).sort({ _id: -1 }).limit(1).next() as any;
const envUrl: string = staged?.envUrl;
if (!envUrl) throw new Error('no env url on latest session');
console.log('env', envUrl);
const tenant: string = s?.tenantId ?? (s?.msAccessToken ? tenantIdFromToken(s.msAccessToken) : '');
if (!tenant) throw new Error('no tenant on session');
const token = await clientCredsToken(tenant, envUrl);
const q = `${envUrl}/api/data/v9.2/botcomponents?$select=name,componenttype,statecode,statuscode,componentstate,modifiedon&$filter=_parentbotid_value eq ${botId}`;
const r = await fetch(q, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } });
const body = await r.json() as any;
if (!r.ok) { console.log('HTTP', r.status, JSON.stringify(body).slice(0, 400)); process.exit(1); }
const rows = body.value ?? [];
console.log('total returned:', rows.length);
for (const c of rows) {
  if (String(c.componenttype) === '16' || String(c.componenttype) === '15') {
    console.log(`  type=${c.componenttype} state=${c.statecode} status=${c.statuscode} compstate=${c.componentstate} mod=${c.modifiedon} name=${c.name}`);
  }
}
const t: Record<string, number> = {};
for (const c of rows) { const k = String(c.componenttype); t[k] = (t[k] ?? 0) + 1; }
console.log('byType:', JSON.stringify(t));
process.exit(0);
