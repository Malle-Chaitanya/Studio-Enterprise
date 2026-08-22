/**
 * Would filtering on CCIBOTSPROD hide anyone who actually OWNS a migrated agent?
 *
 * This is the question that decides the setting. A licence filter is only safe if every
 * principal the mapping grid must offer survives it; one missing owner means the grid
 * cannot express that agent's mapping at all.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { graphTokenFromRefresh, listGraphUsersFiltered } from '../auth/microsoft.js';

const PLAN = 'CCIBOTSPROD';
await connectMongo();
const db = getDb();
const s = await db.collection('migrationSessions').find({}).sort({ _id: -1 }).limit(1).next() as any;
const token = await graphTokenFromRefresh(s.tenantId, s.refreshToken);
if (!token) throw new Error('no graph token');

const { users } = await listGraphUsersFiltered(token, { max: 999, licensedOnly: false });
const byId = new Map(users.map((u) => [u.id, u]));
const holds = (u?: { servicePlans?: string[] }) => !!u?.servicePlans?.some((p) => p.includes(PLAN));

// sourceOwnerId is a DATAVERSE systemuser id, not an Entra object id — they are different
// namespaces and comparing them directly matches nothing, which reads as "every owner is
// missing" when in fact the lookup was wrong. Resolve through systemusers first.
const rows = await db.collection('stagedAgents')
  .find({}, { projection: { sourceOwnerId: 1, envUrl: 1 } }).toArray() as any[];
const envUrl: string = rows.find((r) => r.envUrl)?.envUrl;
const sysIds = [...new Set(rows.map((r) => r.sourceOwnerId).filter(Boolean))];
const { clientCredsToken } = await import('../auth/microsoft.js');
const dvToken = await clientCredsToken(s.tenantId, envUrl);
const owners: string[] = [];
for (const sysId of sysIds) {
  const r = await fetch(
    `${envUrl}/api/data/v9.2/systemusers(${sysId})?$select=azureactivedirectoryobjectid,internalemailaddress,fullname`,
    { headers: { Authorization: `Bearer ${dvToken}`, Accept: 'application/json' } },
  );
  if (!r.ok) { console.log(`  systemuser ${sysId} lookup ${r.status}`); continue; }
  const j = await r.json() as any;
  console.log(`  owner: ${j.fullname} <${j.internalemailaddress}> aad=${j.azureactivedirectoryobjectid ?? '-'}`);
  if (j.azureactivedirectoryobjectid) owners.push(j.azureactivedirectoryobjectid);
}
console.log(`distinct staged-agent owners resolved: ${owners.length} of ${sysIds.length}`);
let missing = 0, unknown = 0, ok = 0;
for (const id of owners) {
  if (!id) continue;
  const u = byId.get(String(id));
  if (!u) { unknown++; console.log(`  NOT IN ACTIVE DIRECTORY  ownerId=${id}`); continue; }
  if (holds(u)) { ok++; continue; }
  missing++;
  console.log(`  WOULD BE HIDDEN  ${u.email}  plans=${(u.servicePlans ?? []).join(',') || '(none)'}`);
}
console.log(`\nholds ${PLAN}: ${ok}   would be hidden: ${missing}   not in active dir: ${unknown}`);
process.exit(0);
