import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ConnectorOpIndex } from './operationBinding.js';

/**
 * Resolving a connector to the vendor API that actually serves it, and surviving the ways
 * that fetch can go wrong.
 *
 * Two properties matter more than the happy path, and both are asserted below:
 *
 *   it must not resolve a connector to the WRONG API. Candidates are generated loosely from
 *   names, which is only safe because verification against the connector's own captured
 *   paths is strict. A candidate that accounts for none of them must be discarded, leaving
 *   the connector exactly where it was.
 *
 *   it must not refuse because of one bad minute. A `requireVendorSpec` binding refuses every
 *   operation when no surface is available, so "Google's docs host was briefly down" and "we
 *   have never read this API" must not look the same. Retry, then stale-beats-nothing.
 *
 * Mongo and the network are both mocked: the logic under test is which API wins and when,
 * not whether the driver works.
 */

const repo = vi.hoisted(() => ({
  getCachedVendorSurface: vi.fn(),
  getResolvedApiFor: vi.fn(),
  putCachedVendorSurface: vi.fn(),
  recordResolvedApi: vi.fn(),
}));
vi.mock('../db/repos/vendorApiSurface.js', () => repo);

const { resolveVendorApiSurface, __resetVendorSpecCache } = await import('./vendorSpec.js');

/** Google's directory, trimmed. `calendar` is the right answer for the index below;
 *  `calendarappsscript` is the near-miss a name-based candidate list will also propose. */
const DIRECTORY = {
  items: Array.from({ length: 60 }, (_, i) => ({ name: `filler${i}`, discoveryRestUrl: `https://d/filler${i}`, title: `Filler ${i}` })).concat([
    { name: 'calendar', discoveryRestUrl: 'https://d/calendar', title: 'Calendar API' },
    { name: 'calendarappsscript', discoveryRestUrl: 'https://d/calendarappsscript', title: 'Calendar Apps Script API' },
  ] as never),
};

const CALENDAR_DOC = {
  baseUrl: 'https://www.googleapis.com/calendar/v3/',
  resources: {
    events: {
      methods: {
        list: { id: 'calendar.events.list', httpMethod: 'GET', flatPath: 'calendars/{calendarId}/events' },
        get: { id: 'calendar.events.get', httpMethod: 'GET', flatPath: 'calendars/{calendarId}/events/{eventId}' },
      },
    },
    calendarList: {
      methods: { list: { id: 'calendar.calendarList.list', httpMethod: 'GET', flatPath: 'users/me/calendarList' } },
    },
  },
};

/** Same shape, nothing in common with the connector's paths — the wrong candidate. */
const WRONG_DOC = {
  baseUrl: 'https://script.googleapis.com/v1/',
  resources: { scripts: { methods: { run: { id: 'script.scripts.run', httpMethod: 'POST', flatPath: 'scripts/{scriptId}:run' } } } },
};

function calendarIndex(connectorId: string): ConnectorOpIndex {
  const op = (path: string) => ({ method: 'GET', path, summary: '', parameters: [] });
  return {
    connectorId,
    displayName: 'Google Calendar',
    proxyHost: 'x', proxyBasePath: '/', securityDefinitions: {}, connectionAuth: {},
    operationCount: 3,
    operations: {
      ListCalendars: op('/{connectionId}/users/me/calendarList'),
      ListEvents: op('/{connectionId}/calendars/{calendarId}/events'),
      GetEvent: op('/{connectionId}/calendars/{calendarId}/events/{eventId}'),
    },
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

function serve(routes: Record<string, unknown>, failures: Record<string, number> = {}) {
  const left = { ...failures };
  fetchMock = vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((k) => String(url).includes(k));
    if (key && left[key]) {
      left[key] -= 1;
      return { ok: false, status: 503, json: async () => ({}) } as never;
    }
    if (!key) return { ok: false, status: 404, json: async () => ({}) } as never;
    return { ok: true, status: 200, json: async () => routes[key] } as never;
  });
  vi.stubGlobal('fetch', fetchMock);
}

beforeEach(() => {
  __resetVendorSpecCache();
  vi.clearAllMocks();
  repo.getCachedVendorSurface.mockResolvedValue(null);
  repo.getResolvedApiFor.mockResolvedValue(null);
  repo.putCachedVendorSurface.mockResolvedValue(undefined);
  repo.recordResolvedApi.mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe('resolveVendorApiSurface — finding the right API without a curated entry', () => {
  it('resolves an UNCURATED connector from its own captured paths', async () => {
    serve({ '/apis?': DIRECTORY, 'd/calendar': CALENDAR_DOC, 'd/calendarappsscript': WRONG_DOC });
    // Not in GOOGLE_APPS. The whole point: a customer using a Google app nobody listed.
    const s = await resolveVendorApiSurface('shared_googlecalendarx', calendarIndex('shared_googlecalendarx'));
    expect(s?.api).toBe('calendar');
    expect(s?.methods.map((m) => m.id)).toContain('calendar.events.list');
    // The mapping is remembered so the candidate fetches happen once ever, not per migration.
    expect(repo.recordResolvedApi).toHaveBeenCalledWith('calendar', 'shared_googlecalendarx');
  });

  it('refuses to resolve when NO candidate accounts for the connector\'s paths', async () => {
    // The safety property that makes loose candidate generation acceptable. Both candidates
    // are served, neither matches, so the answer is "none" rather than the best of a bad lot.
    serve({ '/apis?': DIRECTORY, 'd/calendar': WRONG_DOC, 'd/calendarappsscript': WRONG_DOC });
    const s = await resolveVendorApiSurface('shared_googlecalendarx', calendarIndex('shared_googlecalendarx'));
    expect(s).toBeUndefined();
    expect(repo.recordResolvedApi).not.toHaveBeenCalled();
  });

  it('does not guess without evidence — no index means no resolution', async () => {
    serve({ '/apis?': DIRECTORY, 'd/calendar': CALENDAR_DOC });
    expect(await resolveVendorApiSurface('shared_googlecalendarx')).toBeUndefined();
  });

  it('never writes a CUSTOM connector id into the cross-tenant cache', async () => {
    // A custom connector's id is built from the display name its author typed, which is the
    // customer's own business naming. vendorApiSurfaces is shared by every tenant.
    serve({ '/apis?': DIRECTORY, 'd/calendar': CALENDAR_DOC });
    const id = 'shared_get-20crm-20objects-20from-20acme-5fdd816392';
    expect(await resolveVendorApiSurface(id, calendarIndex(id))).toBeUndefined();
    expect(repo.recordResolvedApi).not.toHaveBeenCalled();
  });

  it('uses a previously resolved mapping without re-running candidate generation', async () => {
    repo.getResolvedApiFor.mockResolvedValue('calendar');
    serve({ '/apis?': DIRECTORY, 'd/calendar': CALENDAR_DOC });
    const s = await resolveVendorApiSurface('shared_googlecalendarx', calendarIndex('shared_googlecalendarx'));
    expect(s?.api).toBe('calendar');
    // Straight to the known API: the near-miss candidate is never fetched.
    expect(fetchMock.mock.calls.every((c) => !String(c[0]).includes('calendarappsscript'))).toBe(true);
  });
});

describe('resolveVendorApiSurface — surviving a bad minute', () => {
  it('retries a 503 rather than downgrading every verified binding in the run', async () => {
    serve({ '/apis?': DIRECTORY, 'd/calendar': CALENDAR_DOC }, { 'd/calendar': 2 });
    const s = await resolveVendorApiSurface('shared_googlecalendar');
    expect(s?.api).toBe('calendar');
  });

  it('serves a STALE surface rather than nothing when the refresh fails', async () => {
    // A requireVendorSpec binding refuses everything without a surface. An API a month past
    // its refresh still exists; a documentation host having a bad minute must not read as
    // "we have never seen this API".
    const stale = { api: 'calendar', methods: [{ id: 'calendar.events.list', httpMethod: 'GET', url: 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events' }] };
    repo.getCachedVendorSurface.mockImplementation(async (_api: string, maxAge: number) =>
      (Number.isFinite(maxAge) ? null : stale));
    serve({ '/apis?': DIRECTORY }); // the doc itself 404s
    const s = await resolveVendorApiSurface('shared_googlecalendar');
    expect(s).toEqual(stale);
  });

  it('returns nothing when the API was never read, so a verified binding refuses honestly', async () => {
    serve({ '/apis?': DIRECTORY });
    expect(await resolveVendorApiSurface('shared_googlecalendar')).toBeUndefined();
  });

  it('rejects a truncated directory instead of caching it for the process lifetime', async () => {
    serve({ '/apis?': { items: [{ name: 'calendar', discoveryRestUrl: 'https://d/calendar', title: 'Calendar API' }] }, 'd/calendar': CALENDAR_DOC });
    const s = await resolveVendorApiSurface('shared_googlecalendarx', calendarIndex('shared_googlecalendarx'));
    expect(s).toBeUndefined();
  });

  it('does not memoise a transient failure as "this API is unavailable"', async () => {
    serve({ '/apis?': DIRECTORY });
    expect(await resolveVendorApiSurface('shared_googlecalendar')).toBeUndefined();
    // Second call, now that the doc is being served: must try again, not replay the miss.
    serve({ '/apis?': DIRECTORY, 'd/calendar': CALENDAR_DOC });
    expect((await resolveVendorApiSurface('shared_googlecalendar'))?.api).toBe('calendar');
  });
});
