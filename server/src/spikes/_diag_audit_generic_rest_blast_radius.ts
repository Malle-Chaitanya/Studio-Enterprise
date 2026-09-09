/** Size the blast radius of the generic_rest.py build_tools bug (fixed this session):
 *  every connector kind that falls through to the generic fallback in adk_deploy.py's
 *  dispatch (Dataverse + any custom/generic connector NOT special-cased: sharepoint,
 *  onedrive, googledrive, gmail, calendar, contacts, outlook, chat, teams, jira,
 *  confluence, hubspot*) has been silently broken since commit 6e28a09f (2026-08-12).
 *  Read-only. npx tsx src/spikes/_diag_audit_generic_rest_blast_radius.ts */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { config } from '../config.js';

await connectMongo();
const db = getDb(config.CSGE_DB);

const SPECIAL_CASED = new Set([
  'sharepointonline', 'sharepoint', 'onedrive',
  'googledrive',
  'gmail',
  'googlecalendar', 'calendar',
  'googlecontacts', 'contacts',
  'outlook',
  'googlechat', 'chat',
  'teams',
  'jira',
  'confluence',
]);
function isHubspot(kind: string) {
  return kind.startsWith('hubspot');
}

const CUTOFF = new Date('2026-08-12T11:31:00Z'); // commit 6e28a09f, 2026-08-12 17:01:00 +0530

const cursor = db.collection('stagedAgents').find({
  deployed: true,
  insertedAt: { $gte: CUTOFF },
});

let total = 0;
let affected = 0;
const affectedList: { appUserId: string; name: string; insertedAt: unknown; kinds: string[] }[] = [];

for await (const doc of cursor) {
  total++;
  // Real field, confirmed live: mapped.ir.agentTools, kind === 'connector', connectorId
  // like "shared_commondataserviceforapps" -> stripped to "commondataserviceforapps"
  // by connectorToolBuilder.ts's own `connectorId.replace(/^shared_/, '')` before it
  // becomes the "kind" string adk_deploy.py dispatches on.
  const tools = (doc as any)?.mapped?.ir?.agentTools ?? [];
  const kinds: string[] = [];
  for (const t of tools) {
    if (t?.kind !== 'connector' || !t?.connectorId) continue;
    const kind = String(t.connectorId).replace(/^shared_/, '').toLowerCase();
    const isSpecial = SPECIAL_CASED.has(kind) || isHubspot(kind);
    if (!isSpecial) kinds.push(kind);
  }
  if (kinds.length) {
    affected++;
    affectedList.push({
      appUserId: (doc as any).appUserId,
      name: (doc as any).name,
      insertedAt: (doc as any).insertedAt,
      kinds,
    });
  }
}

console.log(`Deployed agents since ${CUTOFF.toISOString()}: ${total}`);
console.log(`Agents hitting the generic_rest.py fallback (Dataverse / unlisted connectors): ${affected}`);
for (const a of affectedList) {
  console.log(`  - appUserId=${a.appUserId} name="${a.name}" insertedAt=${a.insertedAt} kinds=[${a.kinds.join(', ')}]`);
}
process.exit(0);
