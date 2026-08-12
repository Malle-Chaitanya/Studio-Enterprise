/**
 * Recovering a missing SharePoint address is an INFERENCE that decides what content an
 * agent answers from. These tests pin the two behaviours that matter: it must find the
 * address when the tenant agrees on one, and it must refuse when the tenant does not.
 *
 * Payloads are the real shapes read from Dataverse on 2026-08-13.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { recoverSharePointUrlByName } from './sharePointUrlRecovery.js';

const ENV = 'https://orga243378d.crm.dynamics.com';
const TOKEN = 'test-token';

/** One Dataverse response; the fetch body is all this function reads. */
function mockRows(rows: unknown[], ok = true, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, status, json: async () => ({ value: rows }), text: async () => '' })),
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('recoverSharePointUrlByName', () => {
  it('recovers the address a sibling agent kept, and names where it came from', async () => {
    mockRows([
      {
        name: 'daily_queries.txt',
        schemaname: 'cr88d_CSGEKnowledgeTestAgent.topic.daily_queriestxt_7PgDbxwA9JNBCq4dNg_sv',
        data: 'kind: KnowledgeSourceConfiguration\nsource:\n  kind: FederatedStructuredSearchSource\n  skillConfiguration: daily_queriestxt_ZEHQ13QHyGoE_iNOUiCtg\n',
      },
      {
        name: 'daily_queries.txt',
        schemaname: 'msdyn_c2messagegeneratoragent.topic.daily_queriestxt_Sub5wzEcEfZNleCgziYLd',
        data: 'url: https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions/daily_queries.txt\n',
      },
    ]);

    const r = await recoverSharePointUrlByName(ENV, TOKEN, 'daily_queries.txt');
    expect(r.status).toBe('recovered');
    if (r.status !== 'recovered') return;
    expect(r.url).toBe('https://filefuze.sharepoint.com/Shared%20Documents/TestingPermissions/daily_queries.txt');
    expect(r.fromSchemaName).toContain('c2messagegeneratoragent');
  });

  it('refuses when two different addresses share one source name', async () => {
    // Grounding on the wrong file is worse than not grounding at all.
    mockRows([
      { name: 'Policies', schemaname: 'a', data: 'url: https://x.sharepoint.com/sites/HR/Policies\n' },
      { name: 'Policies', schemaname: 'b', data: 'url: https://x.sharepoint.com/sites/Legal/Policies\n' },
    ]);

    const r = await recoverSharePointUrlByName(ENV, TOKEN, 'Policies');
    expect(r.status).toBe('ambiguous');
    if (r.status !== 'ambiguous') return;
    expect(r.urls).toHaveLength(2);
  });

  it('ignores non-SharePoint URLs in the same payload', async () => {
    // A Confluence or website address must never be handed to the SharePoint downloader.
    mockRows([
      { name: 'Wiki', schemaname: 'a', data: 'url: https://cf2020.atlassian.net/wiki/spaces/ENG\n' },
    ]);

    expect((await recoverSharePointUrlByName(ENV, TOKEN, 'Wiki')).status).toBe('not-found');
  });

  it('strips trailing quote-punctuation from the captured address', async () => {
    mockRows([
      { name: 'Doc', schemaname: 'a', data: '{"url": "https://x.sharepoint.com/Shared Documents/Doc.pdf".}' },
    ]);

    const r = await recoverSharePointUrlByName(ENV, TOKEN, 'Doc');
    expect(r.status).toBe('recovered');
    if (r.status !== 'recovered') return;
    expect(r.url.endsWith('.')).toBe(false);
  });

  it('escapes a quote in the source name instead of emitting a broken filter', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ value: [] }), text: async () => '' }));
    vi.stubGlobal('fetch', fetchMock);

    await recoverSharePointUrlByName(ENV, TOKEN, "Erik's Notes");
    const url = String((fetchMock.mock.calls as unknown as unknown[][])[0][0]);
    expect(decodeURIComponent(url)).toContain("name eq 'Erik''s Notes'");
  });

  it('does not query on a name too short to identify anything', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect((await recoverSharePointUrlByName(ENV, TOKEN, 'HR')).status).toBe('not-found');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('degrades to not-found when Dataverse refuses, rather than throwing', async () => {
    // A failed recovery must never fail the migration — the old fallback still applies.
    mockRows([], false, 403);
    expect((await recoverSharePointUrlByName(ENV, TOKEN, 'daily_queries.txt')).status).toBe('not-found');
  });
});
