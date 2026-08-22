/**
 * How wrong were the ledger's "N agents" figures? Rows vs distinct agents, for the two claims
 * §1.50 actually made in numbers, so the correction quotes measurements and not memory.
 *
 *   cd server && npx tsx src/spikes/_diag_row_vs_agent.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';

await connectMongo();
const staged = await db_rows();
async function db_rows() {
  return getDb().collection('stagedAgents').find({}).toArray() as Promise<Array<Record<string, unknown>>>;
}

const key = (r: Record<string, unknown>) => String(r.sourceId ?? r.displayName ?? `_id:${String(r._id)}`);
const HUBSPOT = new Set(['shared_hubspot', 'shared_hubspotcrmv2', 'shared_hubspotsettingsv2', 'shared_hubspotcrm', 'shared_hubspotcms']);

let getTeamRows = 0;
const getTeamAgents = new Set<string>();
let hubspotRows = 0;
let hubspotToolRefs = 0;
let hubspotAnyIdRefs = 0;
let customRows = 0;
const customAgents = new Set<string>();
const hubspotAgents = new Set<string>();
const allAgents = new Set<string>();

for (const row of staged) {
  allAgents.add(key(row));
  const mapped = row.mapped as { ir?: { agentTools?: Array<Record<string, unknown>> } } | undefined;
  let rowHasTeam = false;
  let rowHasHubspot = false;
  for (const t of mapped?.ir?.agentTools ?? []) {
    const c = String(t.connectorId ?? t.connector ?? '');
    const op = String(t.operationId ?? t.operation ?? '');
    if (op === 'GetTeam') rowHasTeam = true;
    if (HUBSPOT.has(c)) { rowHasHubspot = true; hubspotToolRefs++; }
    if (c.includes('hubspot')) hubspotAnyIdRefs++;
    // The CUSTOM connector: its own row-vs-agent check, because "5 agents" for it was also
    // never re-derived.
    if (c.startsWith('shared_get-20crm')) { customRows++; customAgents.add(key(row)); }
  }
  if (rowHasTeam) { getTeamRows++; getTeamAgents.add(key(row)); }
  if (rowHasHubspot) { hubspotRows++; hubspotAgents.add(key(row)); }
}

console.log(`total          rows=${staged.length}  agents=${allAgents.size}`);
console.log(`GetTeam        rows=${getTeamRows}  agents=${getTeamAgents.size}`);
console.log(`HubSpot (any)  rows=${hubspotRows}  agents=${hubspotAgents.size}`);
// Three units get confused as "agents": rows, tool references, and actual agents. Print all
// three, because the ledger's "33" is none of the first two by accident.
console.log(`HubSpot toolrefs (5 known ids)=${hubspotToolRefs}  (any id containing hubspot)=${hubspotAnyIdRefs}`);
console.log(`custom CRM conn  refs=${customRows}  agents=${customAgents.size}`);
process.exit(0);
