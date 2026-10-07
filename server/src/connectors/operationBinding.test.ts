import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  bindOperation,
  connectorReadiness,
  VENDOR_BINDINGS,
  type ConnectorOpIndex,
  type VendorApiSurface,
} from './operationBinding.js';

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

  it('reports SharePoint GetAllTables as reproduced by a hand-written tool, not blocked', () => {
    // GetAllTables is the ONE operation across the three proxy-only Microsoft connectors
    // that any staged agent actually calls (_diag_ms_op_usage.ts, 131 agents, 2026-08-19).
    // It is reproduced by `sharepoint_list_lists`, so reporting it as "will not be
    // recreated" would understate what migrated — the honesty rule cuts both ways.
    const r = bindOperation(index('shared_sharepointonline'), 'GetAllTables');
    expect(r.status).toBe('custom-tool');
    if (r.status !== 'custom-tool') return;
    expect(r.reason).toContain('sharepoint_list_lists');
    // The note must state the narrowing, or a customer reads "migrated" as "identical".
    expect(r.reason).toContain('NARROWED');
  });

  it('counts a custom-tool operation as ready, while still surfacing its note', () => {
    const r = connectorReadiness(index('shared_sharepointonline'), ['GetAllTables']);
    expect(r.ready).toBe(true);
    expect(r.bindable).toContain('GetAllTables');
    expect(r.blocked).toHaveLength(0);
    expect(r.customTool).toHaveLength(1);
    expect(r.customTool[0].operationId).toBe('GetAllTables');
  });

  it('does not let a custom tool rescue the rest of a proxy-only connector', () => {
    // The override is per-operation on purpose. HttpRequest stays refused: reproducing it
    // faithfully would grant tenant-wide site read.
    const r = connectorReadiness(index('shared_sharepointonline'), ['GetAllTables', 'HttpRequest']);
    expect(r.ready).toBe(false);
    expect(r.blocked.map((b) => b.operationId)).toEqual(['HttpRequest']);
    expect(r.customTool).toHaveLength(1);
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

/**
 * Confirming a binding against the VENDOR's own published API, instead of inferring it from
 * the connector path's shape.
 *
 * Every case below was found live on 2026-10-07 against a real customer tenant, in the
 * connector the shape heuristic was most confident about. The three it could not see are the
 * reason this exists: a Power Platform filter convention that returns the WRONG resource, a
 * polling trigger spelled differently from the one the regex knows, and an API Google retired
 * in 2022 whose paths are still perfectly shaped.
 */
const CALENDAR_SURFACE: VendorApiSurface = {
  api: 'calendar',
  methods: [
    { id: 'calendar.calendarList.list', httpMethod: 'GET', url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList' },
    { id: 'calendar.events.list', httpMethod: 'GET', url: 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events' },
    { id: 'calendar.events.insert', httpMethod: 'POST', url: 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events' },
    { id: 'calendar.events.get', httpMethod: 'GET', url: 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}' },
    { id: 'calendar.events.delete', httpMethod: 'DELETE', url: 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}' },
  ],
};

/** The real shape captured from the customer environment, trimmed to the cases under test. */
function calendarIndex(): ConnectorOpIndex {
  const op = (method: string, path: string) => ({ method, path, summary: '', parameters: [] });
  return {
    connectorId: 'shared_googlecalendar',
    displayName: 'Google Calendar',
    proxyHost: 'example.azure-apihub.net',
    proxyBasePath: '/apim/googlecalendar',
    securityDefinitions: {},
    connectionAuth: {},
    operationCount: 6,
    operations: {
      ListCalendars: op('GET', '/{connectionId}/users/me/calendarList'),
      ListEvents: op('GET', '/{connectionId}/calendars/{calendarId}/events'),
      DeleteEvent: op('DELETE', '/{connectionId}/calendars/{calendarId}/events/{eventId}'),
      // The dangerous one: `1` is a Power Platform filter convention, not a path segment.
      ListWritableCalendars: op('GET', '/{connectionId}/users/me/calendarList/1'),
      // A polling trigger the `/^\/trigger\d*\//` heuristic does not match.
      OnEventStarted: op('GET', '/{connectionId}/eventstarted/calendars/{calendar_id}/events'),
      // Real resource, wrong verb — the vendor serves events.get, not events.put.
      PutEvent: op('PUT', '/{connectionId}/calendars/{calendarId}/events/{eventId}'),
    },
  };
}

describe('bindOperation — vendor-spec verification', () => {
  it('confirms a real method and says so, naming the vendor id', () => {
    const r = bindOperation(calendarIndex(), 'ListEvents', CALENDAR_SURFACE);
    expect(r.status).toBe('bindable');
    if (r.status !== 'bindable') return;
    expect(r.operation.urlTemplate).toBe('https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events');
    expect(r.operation.provenance).toBe('vendor-spec');
    expect(r.operation.vendorMethodId).toBe('calendar.events.list');
  });

  it('refuses a Power Platform filter convention that would return the WRONG resource', () => {
    // GET /users/me/calendarList/1 is shaped exactly like a real path and is not one. Bound
    // verbatim it fetches the calendar whose id is "1" — data, not an error, which is why no
    // amount of shape checking catches it.
    const r = bindOperation(calendarIndex(), 'ListWritableCalendars', CALENDAR_SURFACE);
    expect(r.status).toBe('not-in-vendor-api');
    if (r.status !== 'not-in-vendor-api') return;
    expect(r.reason).toContain('publishes no method');
  });

  it('refuses a trigger the path-shape heuristic does not match', () => {
    // /eventstarted/ is a polling trigger, and the hand-written `/^\/trigger\d*\//` regex
    // misses it. Discovery refuses it without anyone having to add a shape to a list.
    const r = bindOperation(calendarIndex(), 'OnEventStarted', CALENDAR_SURFACE);
    expect(r.status).toBe('not-in-vendor-api');
  });

  it('separates a wrong verb from a missing resource, because the fix differs', () => {
    const r = bindOperation(calendarIndex(), 'PutEvent', CALENDAR_SURFACE);
    expect(r.status).toBe('not-in-vendor-api');
    if (r.status !== 'not-in-vendor-api') return;
    expect(r.reason).toContain('GET');
    expect(r.reason).toContain('calendar.events.get');
  });

  it('names a base URL that reaches none of the vendor methods', () => {
    // The live bug this caught: googleCatalog gave shared_googlecontacts a base ending in
    // /v1 while its own paths already carry `people/v1`, so every People API operation
    // addressed /v1/people/v1/... A path-level refusal would have blamed the operation.
    const wrongBase: VendorApiSurface = { api: 'calendar', methods: [
      { id: 'calendar.events.list', httpMethod: 'GET', url: 'https://elsewhere.googleapis.com/v9/events' },
    ] };
    const r = bindOperation(calendarIndex(), 'ListEvents', wrongBase);
    expect(r.status).toBe('not-in-vendor-api');
    if (r.status !== 'not-in-vendor-api') return;
    expect(r.reason).toContain('base URL');
    expect(r.reason).toContain('is wrong, not the operation');
  });

  it('explains a capability the vendor has but the connector routes through a prefix', () => {
    // shared_googlecontacts' PeopleApi* operations, generalised: the vendor serves the
    // method, the connector addresses it through a Power Platform namespace. Refused either
    // way — the point is that the reason tells a human it is a rewrite, not a dead API.
    const idx = calendarIndex();
    idx.operations.PrefixedList = { method: 'GET', path: '/{connectionId}/legacy/calendars/{calendarId}/events', summary: '', parameters: [] };
    const r = bindOperation(idx, 'PrefixedList', CALENDAR_SURFACE);
    expect(r.status).toBe('not-in-vendor-api');
    if (r.status !== 'not-in-vendor-api') return;
    expect(r.reason).toContain('calendar.events.list');
    expect(r.reason).toContain('Power Platform prefix');
  });
});

describe('bindOperation — verification is additive, never a regression', () => {
  it('without a surface, a normal connector binds exactly as before and says heuristic', () => {
    const r = bindOperation(index('shared_hubspotcrm'), 'CompaniesList');
    expect(r.status).toBe('bindable');
    if (r.status !== 'bindable') return;
    expect(r.operation.urlTemplate).toBe('https://api.hubapi.com/crm/v3/objects/companies');
    // The claim is marked unproven rather than quietly presented as checked.
    expect(r.operation.provenance).toBe('heuristic');
    expect(r.operation.vendorMethodId).toBeUndefined();
  });

  it('a requireVendorSpec binding REFUSES when the vendor API could not be read', () => {
    // The whole point of the flag. Falling back to shape here would silently reintroduce
    // calendarList/1 and /eventstarted/ the first time Google's docs endpoint is slow.
    const r = bindOperation(calendarIndex(), 'ListEvents');
    expect(r.status).toBe('not-in-vendor-api');
    if (r.status !== 'not-in-vendor-api') return;
    expect(r.reason).toContain('could not be read');
  });

  it('refuses before verifying when the connector is proxy-only, keeping the old reason', () => {
    const r = bindOperation(index('shared_googledrive'), 'GetFileContent', CALENDAR_SURFACE);
    expect(r.status).toBe('proxy-only');
  });
});
