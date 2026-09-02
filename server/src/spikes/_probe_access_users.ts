/**
 * THE ANSWER TO "what goes in the source list": resolve every principal that can access a
 * cached agent — owner + shares — into real people, and count them.
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { clientCredsToken } from '../auth/microsoft.js';

await connectMongo();
const d = getDb();
const s = await d.collection('migrationSessions').find({}).sort({_id:-1}).limit(1).next() as any;
const agents = await d.collection('agentIRCache')
  .find({ 'ir.permissions': { $exists: true } })
  .project({ envUrl: 1, sourceId: 1, 'ir.name': 1, 'ir.permissions': 1, _id: 0 })
  .toArray() as any[];

const byEnv = new Map<string, any[]>();
for (const a of agents) (byEnv.get(a.envUrl) ?? byEnv.set(a.envUrl, []).get(a.envUrl)!).push(a);
console.log(`cached agents with permissions: ${agents.length} across ${byEnv.size} env(s)`);

/** email -> { name, ownerOf, sharedOn } */
const people = new Map<string, { name?: string; ownerOf: number; sharedOn: number }>();
const add = (email: string, name: string | undefined, role: 'owner' | 'shared') => {
  const k = email.toLowerCase();
  const cur = people.get(k) ?? { name, ownerOf: 0, sharedOn: 0 };
  if (!cur.name && name) cur.name = name;
  if (role === 'owner') cur.ownerOf++; else cur.sharedOn++;
  people.set(k, cur);
};

let orgWide = 0, groupPolicy = 0, unresolvedOwners = 0, shareRows = 0;

for (const [envUrl, list] of byEnv) {
  const token = await clientCredsToken(s.tenantId, envUrl);
  const H = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  // one bulk systemusers read, reused for every principal id we see
  const users = new Map<string, { email?: string; name?: string }>();
  const all = await fetch(`${envUrl}/api/data/v9.2/systemusers?$select=systemuserid,internalemailaddress,fullname&$top=5000`, { headers: H });
  for (const u of ((await all.json()) as any).value ?? []) {
    users.set(String(u.systemuserid).toLowerCase(), { email: u.internalemailaddress, name: u.fullname });
  }
  console.log(`${envUrl}: ${list.length} agents, ${users.size} systemusers`);

  for (const a of list) {
    const p = a.ir.permissions ?? {};
    if (p.chatAccess?.policyCode === 0 || p.chatAccess?.policyCode === 3) orgWide++;
    if (p.chatAccess?.policyCode === 2) groupPolicy++;
    const oe = p.owner?.email ?? users.get(String(p.owner?.id ?? '').toLowerCase())?.email;
    if (oe) add(oe, p.owner?.displayName ?? users.get(String(p.owner?.id ?? '').toLowerCase())?.name, 'owner');
    else unresolvedOwners++;

    const q = `principalobjectaccessset?$filter=objectid eq ${a.sourceId}&$select=principalid,accessrightsmask`;
    const r = await fetch(`${envUrl}/api/data/v9.2/${q}`, { headers: H });
    if (!r.ok) continue;
    for (const row of ((await r.json()) as any).value ?? []) {
      shareRows++;
      const u = users.get(String(row.principalid).toLowerCase());
      if (u?.email) add(u.email, u.name, 'shared');
    }
  }
}

console.log(`\norg-wide agents: ${orgWide}   group-policy: ${groupPolicy}   owners unresolved: ${unresolvedOwners}   share rows: ${shareRows}`);
console.log(`\n=== SOURCE LIST: ${people.size} distinct people can access these agents ===`);
for (const [email, v] of [...people].sort((a, b) => (b[1].ownerOf + b[1].sharedOn) - (a[1].ownerOf + a[1].sharedOn))) {
  console.log(`  ${(v.name ?? '-').padEnd(22)} ${email.padEnd(32)} owner:${v.ownerOf} shared:${v.sharedOn}`);
}
process.exit(0);
