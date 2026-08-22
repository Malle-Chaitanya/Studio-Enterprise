import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  COVERAGE,
  CONFLUENCE_COVERAGE,
  JIRA_COVERAGE,
  DRIVE_COVERAGE,
  HUBSPOT_COVERAGE,
  findCoverage,
  hasCoverageTable,
  coverageFor,
} from './coverage.js';
import { REGISTRY_BY_ID } from './registry.js';

/**
 * The honesty rules, ported from equivalence.test.ts because the same temptation applies: the
 * tools are written, they look right, and marking a row `verified` costs nothing at the moment
 * of writing it. These make that cost real.
 */
describe('coverage honesty', () => {
  it('a lost row never names a tool', () => {
    for (const r of COVERAGE.filter((x) => x.fidelity === 'lost')) {
      expect(r.tool, `${r.operationId} is lost but names a tool`).toBeNull();
    }
  });

  it('a non-lost row always names a tool', () => {
    for (const r of COVERAGE.filter((x) => x.fidelity !== 'lost')) {
      expect(r.tool, `${r.operationId} claims ${r.fidelity} but names no tool`).toBeTruthy();
    }
  });

  it('every non-exact row explains itself in specifics', () => {
    for (const r of COVERAGE) {
      if (r.fidelity === 'exact' && !r.reason) continue;
      expect(r.reason, `${r.operationId} has no reason`).toBeTruthy();
      // A bare "narrowed" tells a customer nothing they can act on.
      expect(r.reason!.length, `${r.operationId} reason is too vague to act on`).toBeGreaterThan(40);
    }
  });

  it('every row names a connector that exists in the registry', () => {
    for (const r of COVERAGE) {
      expect(REGISTRY_BY_ID.has(r.connectorId), `${r.connectorId} is not in the registry`).toBe(true);
    }
  });

  it('every claimed tool really exists in the Python module', () => {
    // Guards the drift that matters most: a table row promising `confluence_list_things` when
    // no such function was written reads as coverage in the report and fails only in a
    // conversation with the customer's agent.
    //
    // Table-driven so a new connector's table is checked the moment it is added, instead of
    // being covered only if someone remembers to extend this test.
    for (const [module, rows] of [
      ['confluence', CONFLUENCE_COVERAGE],
      ['jira', JIRA_COVERAGE],
      ['google_drive', DRIVE_COVERAGE],
      ['hubspot', HUBSPOT_COVERAGE],
    ] as const) {
      const src = readFileSync(resolve(`scripts/connector_tools/${module}.py`), 'utf8');
      // Every tool must be RETURNED, not merely defined — a tool that is defined and not
      // returned is invisible to the deployed agent.
      const returned = /return \[([\s\S]*?)\]/.exec(src)?.[1] ?? '';
      for (const r of rows) {
        if (!r.tool) continue;
        expect(src, `${module}.py has no def ${r.tool}`).toContain(`def ${r.tool}(`);
        expect(returned, `${r.tool} is defined but not returned by build_tools`).toContain(r.tool);
      }
    }
  });

  it('only operations exercised live are marked verified', () => {
    // An explicit allow-list, not a blanket rule, so a `verified: true` added anywhere else
    // fails here and has to be justified with evidence. Every id below was returned by a
    // real API call in `_test_confluence_all_tools.ts` / `_test_jira_all_tools.ts`.
    const PROVEN: Record<string, string[]> = {
      shared_confluence: ['GetSpaces', 'GetPagesBySpace', 'GetPageMetadata', 'GetPages'],
      shared_jira: [
        'ListIssues',
        'GetIssue_V2',
        'ListProjects',
        'GetCurrentUser',
        'ListIssueTypes_V2',
        'ListResources',
        // mcp_JiraIssueManagement is deliberately ABSENT: its six operations are each proven
        // above, but the MCP transport itself has never been called, so the row must not
        // borrow their evidence.
      ],
      // All eleven, run live as a real Workspace user with the write paths included.
      shared_googledrive: [
        'ListFolder', 'ListRootFolder', 'GetFileContent', 'GetFileContentByPath',
        'GetFileMetadata', 'GetFileMetadataByPath', 'CreateFileV2', 'UpdateFile',
        'CopyFile', 'DeleteFile', 'ExtractFolderV2',
      ],
      // One token, one portal — so the same three operations are proven for every id that
      // declares them.
      shared_hubspotcrm: ['CompaniesList', 'ListAssociations'],
      shared_hubspotcrmv2: ['CompaniesList', 'ListAssociations'],
      shared_hubspotsettingsv2: ['GetTheDailyApiUsageAndLimitsForAHubspotAccount'],
      shared_hubspot: [
        'CompaniesList', 'ListAssociations', 'GetTheDailyApiUsageAndLimitsForAHubspotAccount',
      ],
    };
    for (const r of [...CONFLUENCE_COVERAGE, ...JIRA_COVERAGE, ...DRIVE_COVERAGE, ...HUBSPOT_COVERAGE]) {
      const proven = new Set(PROVEN[r.connectorId] ?? []);
      expect(Boolean(r.verified), `${r.connectorId}:${r.operationId} verified flag`).toBe(
        proven.has(r.operationId),
      );
    }
  });

  it('no duplicate verdicts for one operation', () => {
    // Two rows for the same operation means the report's answer depends on lookup order.
    const seen = new Set<string>();
    for (const r of COVERAGE) {
      const key = `${r.connectorId}:${r.operationId.toLowerCase()}`;
      expect(seen.has(key), `${key} is judged twice`).toBe(false);
      seen.add(key);
    }
  });

  it('an alias never collides with a real operationId', () => {
    // A `covers` entry that is also another row's operationId would make the alias shadow a
    // more specific verdict.
    const primary = new Set(COVERAGE.map((r) => `${r.connectorId}:${r.operationId.toLowerCase()}`));
    for (const r of COVERAGE) {
      for (const c of r.covers ?? []) {
        const key = `${r.connectorId}:${c.toLowerCase()}`;
        if (key === `${r.connectorId}:${r.operationId.toLowerCase()}`) continue;
        expect(primary.has(key), `${c} is both an alias and its own row`).toBe(false);
      }
    }
  });
});

describe('coverage lookup', () => {
  it('resolves every operation real Confluence agents declare', () => {
    // These four were OBSERVED on the customer's staged agents, not read off documentation:
    // GetPages (27 agents), GetSpaces (18), GetPageMetadata (16), GetPagesBySpace (14).
    for (const op of ['GetPages', 'GetSpaces', 'GetPageMetadata', 'GetPagesBySpace']) {
      expect(findCoverage('shared_confluence', op), `${op} resolves to nothing`).toBeTruthy();
    }
  });

  it('is case-insensitive and resolves aliases', () => {
    expect(findCoverage('shared_confluence', 'getspaces')?.operationId).toBe('GetSpaces');
    expect(findCoverage('shared_confluence', 'GetPageById')?.operationId).toBe('GetPages');
  });

  it('returns undefined — not a lost row — for an unjudged operation', () => {
    // The distinction the whole module exists for: "nobody looked" must be
    // distinguishable from "we looked and it cannot be done".
    expect(findCoverage('shared_confluence', 'SomeOperationNobodyHasJudged')).toBeUndefined();
    // Previously shared_jira:ListIssues — now judged, so a connector with no table at all
    // carries the example instead.
    // shared_googledrive:ListFiles is now an ALIAS of ListFolder, so the unjudged example
    // moved again — to a connector with no table at all.
    // shared_hubspot now has rows, so the unjudged example moves to a connector with none.
    expect(findCoverage('shared_sharepointonline', 'AnythingAtAll')).toBeUndefined();
  });

  it('reports which connectors have a table at all', () => {
    expect(hasCoverageTable('shared_confluence')).toBe(true);
    expect(hasCoverageTable('shared_jira')).toBe(true);
    expect(hasCoverageTable('shared_googledrive')).toBe(true);
    for (const id of [
      'shared_hubspot', 'shared_hubspotcrm', 'shared_hubspotcrmv2', 'shared_hubspotsettingsv2',
    ]) {
      expect(hasCoverageTable(id), `${id} has no table`).toBe(true);
    }
    // Honest about the remaining work rather than pretending these are done.
    for (const id of ['shared_sharepointonline']) {
      expect(hasCoverageTable(id), `${id} unexpectedly has a table — update this test`).toBe(false);
    }
  });

  it('resolves every operation real Jira agents declare', () => {
    // Measured on the customer's staged agents, including the two spellings of the same
    // question (ListIssues / ListIssues_Datacenter) and the MCP server row.
    for (const op of [
      'ListIssues',
      'ListIssues_Datacenter',
      'GetIssue_V2',
      'GetIssue',
      'ListProjects',
      'ListResources',
      'GetCurrentUser',
      'ListIssueTypes_V2',
      'mcp_JiraIssueManagement',
    ]) {
      expect(findCoverage('shared_jira', op), `${op} resolves to nothing`).toBeTruthy();
    }
  });

  it('the Data Center spelling resolves to the Cloud search tool', () => {
    // This site is Cloud, so both operations are answered by the same endpoint. If someone
    // later splits them, this is where the assumption surfaces.
    expect(findCoverage('shared_jira', 'ListIssues_Datacenter')?.tool).toBe('jira_search');
  });

  it('the MCP row is judged, not silently dropped — and never claims to be proven', () => {
    // An MCP server with no verdict would vanish from the report entirely — the customer
    // would never learn the transport is gone. But it is reachable only because
    // opsByConnector is built from the RAW agentTools, where the mcp tool still carries
    // operationId mcp_JiraIssueManagement; boundToolSpec expands it away downstream.
    const mcp = findCoverage('shared_jira', 'mcp_JiraIssueManagement');
    expect(mcp?.fidelity).toBe('narrowed');
    expect(mcp?.reason).toContain('MCP');
    expect(Boolean(mcp?.verified), 'the MCP transport was never called, so it cannot be verified').toBe(false);
  });

  it('every HubSpot id an agent declares can answer for its own operations', () => {
    // findCoverage is keyed by connectorId, so recording an operation against one canonical
    // HubSpot id would leave the report silent for the id the agent actually named — which
    // is how these three connectors came to be reported unsupported in the first place.
    expect(findCoverage('shared_hubspotcrm', 'CompaniesList')?.tool).toBe('hubspot_list_companies');
    expect(findCoverage('shared_hubspotcrmv2', 'ListAssociations')?.tool).toBe('hubspot_list_associations');
    expect(
      findCoverage('shared_hubspotsettingsv2', 'GetTheDailyApiUsageAndLimitsForAHubspotAccount')?.tool,
    ).toBe('hubspot_get_api_usage');
  });

  it('covers every Google Drive operation the customer base actually calls', () => {
    // The 11 measured on staged agents. Drive is the connector where an unjudged operation
    // is most likely to be a WRITE, so a gap here is a file the agent mangles, not just a
    // question it cannot answer.
    for (const op of [
      'ListFolder', 'ListRootFolder', 'GetFileContent', 'GetFileContentByPath',
      'GetFileMetadata', 'GetFileMetadataByPath', 'CreateFileV2', 'UpdateFile',
      'CopyFile', 'DeleteFile', 'ExtractFolderV2',
    ]) {
      expect(findCoverage('shared_googledrive', op), `${op} resolves to nothing`).toBeTruthy();
    }
  });

  it('covers every Confluence operation the customer base actually calls', () => {
    // If a fifth operation shows up in the wild, this is where it gets noticed.
    const judged = new Set(coverageFor('shared_confluence').flatMap((r) => [r.operationId, ...(r.covers ?? [])]));
    for (const op of ['GetPages', 'GetSpaces', 'GetPageMetadata', 'GetPagesBySpace']) {
      expect(judged.has(op), `${op} is used by real agents but unjudged`).toBe(true);
    }
  });
});
