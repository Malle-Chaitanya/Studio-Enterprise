import { describe, it, expect, vi, afterEach } from 'vitest';
import { refreshGoogleToken } from './google.js';

/**
 * The behaviour under test is TELL THE TRUTH ABOUT WHY THE TOKEN IS GONE.
 *
 * A revoked grant and a network blip both used to return null, and the caller answered null
 * by re-presenting the access token it already had. That token was dead, so discovery 401'd
 * and the route reported "falling back to manual entry" — an expired sign-in wearing the
 * costume of a permissions problem. Only `invalid_grant` is permanent; treating anything
 * else as permanent would sign a customer out over a blip.
 */

const json = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as Response;

afterEach(() => vi.unstubAllGlobals());

describe('refreshGoogleToken', () => {
  it('returns the access token on success and asks for no reauth', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, { access_token: 'ya29.fresh' })));
    expect(await refreshGoogleToken('rt')).toEqual({
      accessToken: 'ya29.fresh',
      reauthRequired: false,
    });
  });

  it('flags reauth on invalid_grant — the grant is dead for good', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: 'invalid_grant' })));
    expect(await refreshGoogleToken('rt')).toEqual({ accessToken: null, reauthRequired: true });
  });

  it('does NOT flag reauth on a 5xx — that is transient', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(503, { error: 'backend_error' })));
    expect(await refreshGoogleToken('rt')).toEqual({ accessToken: null, reauthRequired: false });
  });

  it('does NOT flag reauth when the request never completed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await refreshGoogleToken('rt')).toEqual({ accessToken: null, reauthRequired: false });
  });

  it('does NOT flag reauth on an unrelated OAuth error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: 'invalid_scope' })));
    expect(await refreshGoogleToken('rt')).toEqual({ accessToken: null, reauthRequired: false });
  });

  it('treats a 200 with no access_token as a failure, not a success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(200, {})));
    expect(await refreshGoogleToken('rt')).toEqual({ accessToken: null, reauthRequired: false });
  });
});
