/**
 * DESTRUCTIVE. Deletes ONLY the four agent ids approved by a human on 2026-08-21, to give the
 * five-agent end-to-end run a clean create path.
 *
 * The ids are hardcoded and the EXPECTED display name is asserted against a live GET before
 * each delete — an id is not a name, and one of these ("A") does not read like the agent its
 * record claims it is. If the name has changed since it was enumerated, that means something
 * moved and the delete is refused rather than guessed at.
 *
 *   cd server && npx tsx src/spikes/_del_five_dest_copies.ts        # dry run, prints only
 *   cd server && npx tsx src/spikes/_del_five_dest_copies.ts --go   # actually deletes
 */
import 'dotenv/config';
import { getSaToken } from '../auth/google.js';

const PROJECT = 'studio-enterprise-migration';
const ENGINE = 'gemini-enterprise-17847887_1784788734248';
const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${PROJECT}/locations/global/collections/default_collection/engines/${ENGINE}/assistants/default_assistant/agents`;

/** [agentId, exact display name expected right now, why it is on the list] */
const TARGETS: Array<[string, string, string]> = [
  ['18100528233420232026', 'Teams Coordinator', 'record-backed copy of Teams Coordinator'],
  ['5539949030633558392', 'HubSpot Agent', 'record-backed copy of HubSpot Agent'],
  ['11138074654162485859', 'A', 'record maps it to Enterprise Migration Knowledge'],
  ['14380683772344326060', 'HubSpot Agent', 'duplicate display name, no deployment record'],
];

const GO = process.argv.includes('--go');
const token = await getSaToken(process.env.GOOGLE_IMPERSONATE_EMAIL || undefined);

for (const [id, expected, why] of TARGETS) {
  const get = await fetch(`${BASE}/${id}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!get.ok) {
    console.log(`SKIP   ${id}  GET -> ${get.status} (already gone)`);
    continue;
  }
  const a = (await get.json()) as { displayName?: string; state?: string };
  const actual = (a.displayName ?? '').trim();
  if (actual !== expected) {
    console.log(`REFUSE ${id}  expected "${expected}" but it is now "${actual}" — not deleting`);
    continue;
  }
  console.log(`${GO ? 'DELETE' : 'WOULD '} ${id}  "${actual}" state=${a.state}  (${why})`);
  if (!GO) continue;
  const del = await fetch(`${BASE}/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  const body = del.ok ? '' : ` ${(await del.text()).slice(0, 200)}`;
  console.log(`       -> ${del.status}${body}`);
}
console.log(GO ? '\ndone' : '\ndry run — pass --go to delete');
process.exit(0);
