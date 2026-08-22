import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { COVERAGE, findCoverage } from './coverage.js';
import { findEquivalence, surfaceForConnector } from './equivalence.js';
import { hasDedicatedToolModule } from './toolModule.js';

const ORCH = readFileSync(resolve('src/orchestrator.ts'), 'utf8');

/**
 * A coverage table that never reaches the report is decoration.
 *
 * MEASURED 2026-08-20 (`_diag_bindable_vs_blocked.ts`): `findCoverage` was consulted in
 * exactly ONE place — the loop over `readiness.blocked`. There was no loop over the BINDABLE
 * operations, so an operation that binds emitted no per-operation note; and for a connector
 * with a dedicated Python module the bound spec is DROPPED at deploy anyway
 * (connectors/toolModule.ts). Net effect: 13 operations across Confluence (4), Jira (6) and
 * HubSpot (3) had a VERIFIED coverage row that the customer never saw — six of them on 34
 * agents each. Google Drive's eleven were reported only because they happen to be blocked
 * rather than bindable, which is an accident of the captured swagger and not a design.
 *
 * These tests pin the wiring, not the wording.
 */
describe('coverage verdicts reach the report', () => {
  it('the orchestrator consults coverage for DROPPED bound operations, not only blocked ones', () => {
    // The dropped-bound loop must exist and must call findCoverage. Asserted against the
    // source because the alternative is an end-to-end migration run, and the failure this
    // guards is silence — which no assertion on a passing run would notice.
    const droppedLoop = ORCH.indexOf('for (const [connectorId, specs] of boundBuild.byConnector)');
    expect(droppedLoop, 'no loop over bound specs by connector').toBeGreaterThan(-1);
    // ...and the LAST such loop (the reporting one, after the counting one) must consult both
    // tables and emit a note.
    const tail = ORCH.slice(droppedLoop);
    expect(tail, 'the dropped-bound loop does not consult findCoverage').toContain('findCoverage(connectorId');
    expect(tail, 'the dropped-bound loop does not fall back to the equivalence table').toContain(
      'findEquivalence(surface',
    );
    expect(tail, 'the dropped-bound loop emits no fidelity note').toContain('result.fidelity.push');
  });

  it('an unjudged operation is reported as needs-review, never omitted', () => {
    // "Nobody looked" and "we looked and it is fine" must not render identically, and the
    // way that used to happen was by emitting nothing at all.
    const droppedLoop = ORCH.indexOf('for (const [connectorId, specs] of boundBuild.byConnector)');
    const tail = ORCH.slice(droppedLoop);
    expect(tail).toContain("status: 'needs-review'");
    expect(tail).toContain('nobody has confirmed which of them answers this specific operation');
  });

  it('every connector with a coverage table has a dedicated tool module', () => {
    // The two must agree. A coverage row promises a named tool like `hubspot_list_companies`;
    // if the connector had no module it would fall through to generic REST and that tool
    // would not exist at all — the row would describe something the agent never receives.
    for (const connectorId of new Set(COVERAGE.map((r) => r.connectorId))) {
      expect(
        hasDedicatedToolModule(connectorId),
        `${connectorId} has coverage rows naming tools but no dedicated module to provide them`,
      ).toBe(true);
    }
  });

  it('the operations real agents call on a dedicated-module connector are all judged', () => {
    // The board, as an assertion. Every id below was MEASURED on the customer's staged agents
    // (`_diag_tier1_coverage.ts`); if one stops resolving, the report goes quiet about it
    // again and this is the test that says so.
    const OBSERVED: Array<[string, string[]]> = [
      ['shared_confluence', ['GetPages', 'GetSpaces', 'GetPageMetadata', 'GetPagesBySpace']],
      ['shared_jira', [
        'ListIssues', 'ListIssues_Datacenter', 'GetIssue_V2', 'GetIssue', 'ListResources',
        'mcp_JiraIssueManagement',
      ]],
      ['shared_googledrive', [
        'ListFolder', 'GetFileContent', 'ListRootFolder', 'UpdateFile', 'ExtractFolderV2',
        'GetFileMetadataByPath', 'DeleteFile', 'CopyFile', 'CreateFileV2',
        'GetFileContentByPath', 'GetFileMetadata',
      ]],
      ['shared_hubspotcrmv2', ['ListAssociations']],
      ['shared_hubspotcrm', ['CompaniesList']],
      ['shared_hubspotsettingsv2', ['GetTheDailyApiUsageAndLimitsForAHubspotAccount']],
      ['shared_sharepointonline', ['GetAllTables']],
    ];
    for (const [connectorId, ops] of OBSERVED) {
      for (const op of ops) {
        const surface = surfaceForConnector(connectorId);
        const judged = findCoverage(connectorId, op) ?? (surface ? findEquivalence(surface, op) : undefined);
        expect(judged, `${connectorId}:${op} is called by real agents and resolves to nothing`).toBeTruthy();
      }
    }
  });
});
