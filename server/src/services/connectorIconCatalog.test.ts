import { describe, expect, it, vi, beforeEach } from 'vitest';

/**
 * The icon catalog's contract is almost entirely about what it must NOT do.
 *
 * It is read on the Connectors step, a screen the prod logs show being loaded ten times
 * per visit, and what it supplies is decoration. So the tests that matter are: it never
 * blocks that read on the network, it never throws into it, and ten concurrent loads do
 * not become ten calls to Microsoft.
 */

const readIconCatalog = vi.fn();
const putIconCatalog = vi.fn();
const clientCredsToken = vi.fn();

vi.mock('../db/repos/connectorIcons.js', () => ({
  readIconCatalog: (...a: unknown[]) => readIconCatalog(...a),
  putIconCatalog: (...a: unknown[]) => putIconCatalog(...a),
}));
vi.mock('../auth/microsoft.js', () => ({
  clientCredsToken: (...a: unknown[]) => clientCredsToken(...a),
}));

const { iconsFor, refreshIconCatalog } = await import('./connectorIconCatalog.js');

const CTX = { tenantId: 't1', environmentId: 'env1', scope: 'scope1' };
const DAY = 24 * 60 * 60 * 1000;

function catalogResponse(value: unknown[]): Response {
  return { ok: true, status: 200, json: async () => ({ value }) } as unknown as Response;
}

beforeEach(() => {
  vi.restoreAllMocks();
  readIconCatalog.mockReset();
  putIconCatalog.mockReset();
  clientCredsToken.mockReset();
  clientCredsToken.mockResolvedValue('tok');
});

describe('iconsFor', () => {
  it('returns an empty map on a cache miss rather than fetching inline', async () => {
    readIconCatalog.mockResolvedValue(null);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(catalogResponse([]));

    const icons = await iconsFor(CTX);

    expect(icons).toEqual({});
    // The refresh is fired and dropped, so the caller's await resolved without it: what
    // must never happen is the REQUEST waiting on Microsoft.
    expect(fetchSpy).not.toHaveBeenCalledBefore(readIconCatalog as never);
  });

  it('serves a STALE catalog instead of blanking every icon', async () => {
    readIconCatalog.mockResolvedValue({
      icons: { shared_jira: { uri: 'https://cdn/jira.png' } },
      capturedAt: new Date(Date.now() - DAY * 30),
    });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(catalogResponse([]));

    expect(await iconsFor(CTX)).toEqual({ shared_jira: { uri: 'https://cdn/jira.png' } });
  });

  it('never throws when the cache read fails', async () => {
    readIconCatalog.mockRejectedValue(new Error('mongo down'));
    await expect(iconsFor(CTX)).resolves.toEqual({});
  });
});

describe('refreshIconCatalog', () => {
  it('stores iconUri and iconBrandColor keyed by connector id', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(catalogResponse([
      { name: 'shared_jira', properties: { iconUri: 'https://cdn/jira.png', iconBrandColor: '#1F4F81' } },
      { name: 'shared_teams', properties: { iconUri: 'https://cdn/teams.png' } },
    ]));

    await refreshIconCatalog({ ...CTX, environmentId: 'env-store' });

    expect(putIconCatalog).toHaveBeenCalledWith('scope1', 'env-store', {
      shared_jira: { uri: 'https://cdn/jira.png', brand: '#1F4F81' },
      shared_teams: { uri: 'https://cdn/teams.png', brand: undefined },
    });
  });

  it('drops entries with no icon, and any url that is not https', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(catalogResponse([
      { name: 'shared_ok', properties: { iconUri: 'https://cdn/ok.png' } },
      { name: 'shared_none', properties: {} },
      { name: 'shared_insecure', properties: { iconUri: 'http://cdn/no.png' } },
      { name: 'shared_js', properties: { iconUri: 'javascript:alert(1)' } },
      { properties: { iconUri: 'https://cdn/nameless.png' } },
    ]));

    await refreshIconCatalog({ ...CTX, environmentId: 'env-filter' });

    expect(putIconCatalog).toHaveBeenCalledWith('scope1', 'env-filter', {
      shared_ok: { uri: 'https://cdn/ok.png', brand: undefined },
    });
  });

  it('writes nothing when the catalog call fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 403 } as unknown as Response);
    await refreshIconCatalog({ ...CTX, environmentId: 'env-403' });
    expect(putIconCatalog).not.toHaveBeenCalled();
  });

  it('never throws when the network throws', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNRESET'));
    await expect(refreshIconCatalog({ ...CTX, environmentId: 'env-boom' })).resolves.toBeUndefined();
    expect(putIconCatalog).not.toHaveBeenCalled();
  });

  it('collapses concurrent refreshes for one environment into a single call', async () => {
    let release: (r: Response) => void = () => {};
    const pending = new Promise<Response>((r) => { release = r; });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockReturnValue(pending);

    const ctx = { ...CTX, environmentId: 'env-race' };
    const all = Promise.all([refreshIconCatalog(ctx), refreshIconCatalog(ctx), refreshIconCatalog(ctx)]);
    release(catalogResponse([{ name: 'shared_a', properties: { iconUri: 'https://cdn/a.png' } }]));
    await all;

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
