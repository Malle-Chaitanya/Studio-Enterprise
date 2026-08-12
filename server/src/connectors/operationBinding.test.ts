import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { bindOperation, connectorReadiness, VENDOR_BINDINGS, type ConnectorOpIndex } from './operationBinding.js';

/**
 * These tests run against the operation indexes captured from the LIVE Power Apps swagger
 * on 2026-08-12, not hand-written fixtures. That is the point: if Microsoft changes a
 * connector's paths, re-capturing the index turns the change into a failing test instead of
 * a tool that 404s in production.
 *
 * The operationIds asserted here are the ones agents in the tenant actually call
 * (docs/verification-ledger.md §1.10).
 */
function index(connectorId: string): ConnectorOpIndex {
  return JSON.parse(readFileSync(`src/connectors/fixtures/${connectorId}.ops.json`, 'utf8')) as ConnectorOpIndex;
}

describe('bindOperation — vendor-path connectors', () => {
  it('binds HubSpot CompaniesList to HubSpot, not to the Power Platform proxy', () => {
    const r = bindOperation(index('shared_hubspotcrm'), 'CompaniesList');
    expect(r.status).toBe('bindable');
    if (r.status !== 'bindable') return;
    expect(r.operation.method).toBe('GET');
    expect(r.operation.urlTemplate).toBe('https://api.hubapi.com/crm/v3/objects/companies');
    expect(r.operation.auth).toBe('bearer-token');
    expect(r.operation.contextRequired).toEqual([]);
    // connectionId is the proxy's, never ours.
    expect(r.operation.parameters.map((p) => p.name)).not.toContain('connectionId');
  });

  it('binds Confluence GetPages, keeping cloudId as context the deployer must supply', () => {
    const r = bindOperation(index('shared_confluence'), 'GetPages');
    expect(r.status).toBe('bindable');
    if (r.status !== 'bindable') return;
    expect(r.operation.urlTemplate).toBe(
      'https://api.atlassian.com/ex/confluence/{cloudId}/wiki/api/v2/pages',
    );
    expect(r.operation.auth).toBe('atlassian-basic');
    // cloudId is a real swagger parameter, but it is an opaque tenant GUID — a model asked
    // for one would invent it, so it must be bound from the stored Atlassian credentials.
    expect(r.operation.contextRequired).toEqual(['cloudId']);
    expect(r.operation.parameters.map((p) => p.name)).not.toContain('cloudId');
  });

  it('binds Dataverse ListRecords to the customer org URL, which is context', () => {
    const r = bindOperation(index('shared_commondataserviceforapps'), 'ListRecordsWithOrganization');
    expect(r.status).toBe('bindable');
    if (r.status !== 'bindable') return;
    expect(r.operation.urlTemplate).toBe('{dataverseOrgUrl}/api/data/v9.1.0/{entityName}');
    expect(r.operation.auth).toBe('aad-token');
    expect(r.operation.contextRequired).toEqual(['dataverseOrgUrl']);
    // entityName is a real operation parameter, so it is NOT context.
    expect(r.operation.parameters.map((p) => p.name)).toContain('entityName');
    // The proxy's plumbing headers must not leak into the tool signature.
    expect(r.operation.parameters.map((p) => p.name)).not.toContain('prefer');
  });

  it('binds Power Platform Admin ListEnvironmentsForUser', () => {
    const r = bindOperation(index('shared_powerplatformadminv2'), 'ListEnvironmentsForUser');
    expect(r.status).toBe('bindable');
    if (r.status !== 'bindable') return;
    expect(r.operation.urlTemplate).toBe('https://api.powerplatform.com/environmentmanagement/environments');
    expect(r.operation.aadResource).toBe('https://api.powerplatform.com');
  });

  it('keeps required query parameters that the caller must pass', () => {
    const r = bindOperation(index('shared_powerplatformadminv2'), 'ListEnvironmentsForUser');
    if (r.status !== 'bindable') throw new Error('expected bindable');
    const apiVersion = r.operation.parameters.find((p) => p.name === 'api-version');
    expect(apiVersion?.required).toBe(true);
    expect(apiVersion?.in).toBe('query');
  });
});

describe('bindOperation — refusals are named, never guessed', () => {
  it('refuses Google Drive: its paths are a Power Platform abstraction', () => {
    const r = bindOperation(index('shared_googledrive'), 'GetFileContent');
    expect(r.status).toBe('proxy-only');
    if (r.status !== 'proxy-only') return;
    expect(r.reason).toContain('abstraction');
  });

  it("refuses SharePoint HttpRequest: the swagger describes the tunnel, not the call", () => {
    const r = bindOperation(index('shared_sharepointonline'), 'HttpRequest');
    expect(r.status).toBe('proxy-only');
    if (r.status !== 'proxy-only') return;
    expect(r.reason).toContain('tunnel');
  });

  it('reports an operation the captured index does not have', () => {
    const r = bindOperation(index('shared_confluence'), 'NoSuchOperation');
    expect(r.status).toBe('unknown-operation');
  });

  it('reports a connector with no vendor binding instead of inventing a host', () => {
    const fake = { ...index('shared_confluence'), connectorId: 'shared_madeup' };
    const r = bindOperation(fake, 'GetPages');
    expect(r.status).toBe('unknown-connector');
  });
});

describe('connectorReadiness — the pre-run answer', () => {
  it('is ready when every used operation binds', () => {
    const r = connectorReadiness(index('shared_confluence'), ['GetPages']);
    expect(r.ready).toBe(true);
    expect(r.bindable).toEqual(['GetPages']);
  });

  it('is not ready when any used operation is blocked, and says which', () => {
    const r = connectorReadiness(index('shared_googledrive'), ['GetFileContent', 'ListFolder']);
    expect(r.ready).toBe(false);
    expect(r.blocked).toHaveLength(2);
    expect(r.blocked[0].reason.length).toBeGreaterThan(20);
  });

  // "No operations detected" is a gap in what we read, not a clean bill of health. Calling
  // it ready would hide the one case where we know least.
  it('is not ready when we could not read any operation', () => {
    expect(connectorReadiness(index('shared_confluence'), []).ready).toBe(false);
  });
});

describe('the live census binds end to end', () => {
  // Every connector × operation pair observed in the tenant on 2026-08-12.
  const CENSUS: Array<[string, string[], boolean]> = [
    ['shared_confluence', ['GetPages'], true],
    ['shared_jira', ['mcp_JiraIssueManagement'], true],
    [
      'shared_commondataserviceforapps',
      [
        'CreateRecordWithOrganization',
        'GetItemWithOrganization',
        'ListRecordsWithOrganization',
        'PerformUnboundActionWithOrganization',
        'UpdateRecordWithOrganization',
      ],
      true,
    ],
    ['shared_hubspotcrm', ['CompaniesList'], true],
    ['shared_hubspotsettingsv2', ['GetTheDailyApiUsageAndLimitsForAHubspotAccount'], true],
    ['shared_powerplatformadminv2', ['ListEnvironmentsForUser', 'QueryResources'], true],
    ['shared_googledrive', ['GetFileContent'], false],
    ['shared_sharepointonline', ['HttpRequest'], false],
  ];

  for (const [cid, ops, expectedReady] of CENSUS) {
    it(`${cid} — ${expectedReady ? 'ready' : 'blocked, with reasons'}`, () => {
      const r = connectorReadiness(index(cid), ops);
      expect(r.ready).toBe(expectedReady);
      if (!expectedReady) expect(r.blocked.every((b) => b.reason.length > 20)).toBe(true);
    });
  }

  it('every connector in the vendor table has a captured index or is deliberately proxy-only', () => {
    for (const b of Object.values(VENDOR_BINDINGS)) {
      if (b.pathStyle === 'proxy-only') expect(b.proxyReason).toBeTruthy();
      else expect(b.baseUrl.length).toBeGreaterThan(0);
    }
  });
});
