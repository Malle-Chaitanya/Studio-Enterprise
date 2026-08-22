/**
 * For each operation real agents call: which REPORTING PATH carries it, and does it have a
 * verdict to report?
 *
 * WHY THIS EXISTS. The orchestrator used to consult findCoverage in ONE place — the loop over
 * `readiness.blocked`. There was no loop over the BINDABLE operations, so an operation that
 * binds emitted no per-operation note; and for a connector with a dedicated Python module the
 * bound spec is DROPPED at deploy (connectors/toolModule.ts) while the log says "capability is
 * reported per operation below". This spike measured the consequence on 2026-08-20: 13
 * operations across Confluence (4), Jira (6) and HubSpot (3) had a VERIFIED coverage row the
 * customer never saw, six of them on 34 agents each. Google Drive's eleven were reported only
 * because they happen to be BLOCKED rather than bindable — an accident of the captured
 * swagger, not a design.
 *
 * The dropped-bound reporting loop was added in response, so every operation now reaches a
 * path. What this spike watches for now is the remaining shape of the same bug: an operation
 * on a reporting path with NO verdict in either table, which reports as needs-review — honest,
 * and unfinished.
 *
 *   cd server && npx tsx src/spikes/_diag_bindable_vs_blocked.ts
 */
import 'dotenv/config';
import { connectMongo } from '../db/mongo.js';
import { getDb } from '../db/core.js';
import { readinessFor } from '../connectors/readiness.js';
import { hasDedicatedToolModule } from '../connectors/toolModule.js';
import { findCoverage } from '../connectors/coverage.js';
import { findEquivalence, surfaceForConnector } from '../connectors/equivalence.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';

await connectMongo();
const db = getDb();
const staged = await db.collection('stagedAgents').find({}).toArray();

/** connectorId -> operationId -> agents */
const usage = new Map<string, Map<string, number>>();
for (const row of staged as Array<Record<string, unknown>>) {
  const mapped = row.mapped as { ir?: { agentTools?: Array<Record<string, unknown>> } } | undefined;
  for (const t of mapped?.ir?.agentTools ?? []) {
    const c = String(t.connectorId ?? '');
    const o = String(t.operationId ?? '');
    if (!c || !o) continue;
    const m = usage.get(c) ?? new Map<string, number>();
    m.set(o, (m.get(o) ?? 0) + 1);
    usage.set(c, m);
  }
}

const TIER1 = [
  'shared_teams', 'shared_googlechat', 'shared_outlook', 'shared_office365',
  'shared_googledrive', 'shared_confluence', 'shared_jira',
  'shared_sharepointonline', 'shared_onedrive',
  'shared_hubspot', 'shared_hubspotcrmv2', 'shared_hubspotsettingsv2', 'shared_hubspotcrm',
];

let silent = 0;
const silentRows: string[] = [];

/**
 * The verdict for one operation, from EITHER table — the same two-table lookup the
 * orchestrator's reporting loop performs.
 *
 * Checking only coverage.ts over-reported the problem twice tonight: the Teams operations and
 * SharePoint's GetAllTables live in equivalence.ts (cross-vendor, keyed by M365Surface) and
 * were flagged as having no verdict when they have one.
 */
const judgedFor = (connectorId: string, op: string): 'coverage' | 'equivalence' | undefined => {
  if (findCoverage(connectorId, op)) return 'coverage';
  const surface = surfaceForConnector(connectorId);
  if (surface && findEquivalence(surface, op)) return 'equivalence';
  return undefined;
};
for (const connectorId of TIER1) {
  const ops = usage.get(connectorId);
  if (!ops?.size) continue;
  const readiness = readinessFor(connectorId, [...ops.keys()]);
  const dedicated = hasDedicatedToolModule(connectorId);
  console.log(
    `\n=== ${REGISTRY_BY_ID.get(connectorId)?.name ?? connectorId} ` +
      `(${dedicated ? 'dedicated module' : 'generic REST'}) ===`,
  );
  if (!readiness) {
    console.log('  no captured API — readinessFor returned nothing, so the blocked loop never runs');
    for (const [op, n] of ops) {
      const where = judgedFor(connectorId, op);
      console.log(
        `  ${String(n).padStart(3)} agents  ${op.padEnd(40)} (no readiness) ` +
          `${where ? `${where} row` : 'NO verdict'}`,
      );
      if (!where) { silent++; silentRows.push(`${connectorId}:${op}`); }
    }
    continue;
  }
  const blocked = new Set(readiness.blocked.map((b) => b.operationId));
  for (const [op, n] of [...ops].sort((a, b) => b[1] - a[1])) {
    const isBlocked = blocked.has(op);
    const where = judgedFor(connectorId, op);
    // WHICH REPORTING PATH carries this operation:
    //   blocked                     -> the readiness.blocked loop (the original one)
    //   bindable + dedicated module -> the dropped-bound loop, added 2026-08-20 after this
    //                                  spike measured 13 operations reaching NO path at all
    //   bindable + generic REST     -> deployed as a real exact-argument replay; the bound
    //                                  tool IS the report
    const path = isBlocked
      ? 'blocked loop'
      : dedicated
        ? 'dropped-bound loop'
        : 'exact replay (generic REST)';
    // The remaining problem is not the path but the VERDICT: an operation carried by a
    // reporting path that has no coverage/equivalence row is reported as needs-review, which
    // is honest but unfinished.
    const isSilent = !where;
    if (isSilent) { silent++; silentRows.push(`${connectorId}:${op}`); }
    console.log(
      `  ${String(n).padStart(3)} agents  ${op.padEnd(40)} ` +
        `${path.padEnd(28)} ` +
        `${where ? `${where} row` : 'NO verdict'}${isSilent ? '   <-- needs a verdict' : ''}`,
    );
  }
}

console.log(
  `\n${silent} operation(s) reach a reporting path with NO verdict in either table, so they ` +
    `report as needs-review rather than with an answer.`,
);
console.log(
  'Every operation now reaches SOME reporting path; before 2026-08-20 the 13 bindable ones on ' +
    'dedicated-module connectors reached none.',
);
for (const r of silentRows) console.log(`  ${r}`);
process.exit(0);
