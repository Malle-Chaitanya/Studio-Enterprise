import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * One end user authorizing one connector for themselves.
 *
 * The failure this guards against is not an exception — it is a consent that LOOKS like it
 * worked and leaves the user on the shared credential. So the tests are mostly about the
 * refusals: no delegated flow, no client_id, no refresh token, a replayed state.
 */

const upsertSecret = vi.fn();
vi.mock('./secretManager.js', () => ({ upsertSecret: (...a: unknown[]) => upsertSecret(...a) }));
vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const {
  startUserConsent, completeUserConsent, supportsUserAuth, pendingConsentCount,
} = await import('./userConnectorAuth.js');

const base = {
  appUserId: 'u1',
  tenantId: 't1',
  userKey: 'erik@filefuze.co',
  connectorId: 'shared_office365',
  ownerScope: 'scope-a',
  project: 'proj',
  redirectUri: 'https://app.example/cb',
  fields: { client_id: 'cid', client_secret: 'csec', tenant_id: 'tid' },
};

beforeEach(() => {
  upsertSecret.mockReset().mockResolvedValue(undefined);
  vi.restoreAllMocks();
});

describe('starting a consent', () => {
  it('sends the user to the provider with delegated scopes and offline access', () => {
    const { authorizeUrl } = startUserConsent(base);
    const u = new URL(authorizeUrl);
    expect(u.host).toBe('login.microsoftonline.com');
    // {tenant_id} must be filled from the stored credential, not left as a literal.
    expect(u.pathname).toContain('/tid/');
    expect(u.searchParams.get('client_id')).toBe('cid');
    expect(u.searchParams.get('response_type')).toBe('code');
    // Without offline_access the provider issues no refresh token and the credential dies
    // in an hour with nothing to explain it.
    expect(u.searchParams.get('scope')).toContain('offline_access');
    // Delegated scopes, NOT the app-only .default that grants tenant-wide mail access.
    expect(u.searchParams.get('scope')).not.toContain('.default');
  });

  it('refuses a connector with no delegated flow instead of falling back to the shared one', () => {
    // Falling back would deploy the tool as shared while the UI told the user they had
    // connected their own account.
    expect(supportsUserAuth('shared_confluence')).toBe(false);
    expect(() => startUserConsent({ ...base, connectorId: 'shared_confluence' })).toThrow(/no per-user/i);
  });

  it('refuses when the customer has not registered an OAuth app yet', () => {
    // Better than sending the user to a provider page that rejects them for a missing
    // client_id with no clue whose problem it is.
    expect(() => startUserConsent({ ...base, fields: { tenant_id: 'tid' } }))
      .toThrow(/client id and secret/i);
  });

  it('refuses to build a consent with no user', () => {
    expect(() => startUserConsent({ ...base, userKey: '' })).toThrow(/userKey/);
  });
});

describe('completing a consent', () => {
  const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

  it('stores the refresh token under THAT user, and never the shared id', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ refresh_token: 'rt', access_token: 'at' })));
    const { state } = startUserConsent(base);
    const r = await completeUserConsent(state, 'code', 'sa-token', base.fields);
    expect(r.userKey).toBe('erik@filefuze.co');
    expect(r.secretIds[0]).toContain('-u-erik-filefuze-co');
    const [, project, secretId, value] = upsertSecret.mock.calls[0] as string[];
    expect(project).toBe('proj');
    expect(secretId).toContain('-u-erik-filefuze-co');
    expect(value).toBe('rt');
  });

  it('stores nothing when the provider returns no refresh token', async () => {
    // An access-token-only credential works for an hour and then fails with no explanation,
    // which is worse than failing now.
    vi.stubGlobal('fetch', vi.fn(async () => ok({ access_token: 'at' })));
    const { state } = startUserConsent(base);
    await expect(completeUserConsent(state, 'code', 'sa', base.fields)).rejects.toThrow(/no_refresh_token/);
    expect(upsertSecret).not.toHaveBeenCalled();
  });

  it('stores nothing when the exchange is rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 400, json: async () => ({}) })));
    const { state } = startUserConsent(base);
    await expect(completeUserConsent(state, 'code', 'sa', base.fields)).rejects.toThrow(/token_exchange_failed_400/);
    expect(upsertSecret).not.toHaveBeenCalled();
  });

  it('consumes the state so a leaked redirect cannot be replayed', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ok({ refresh_token: 'rt' })));
    const { state } = startUserConsent(base);
    await completeUserConsent(state, 'code', 'sa', base.fields);
    await expect(completeUserConsent(state, 'code', 'sa', base.fields)).rejects.toThrow(/consent_state_unknown/);
    expect(upsertSecret).toHaveBeenCalledTimes(1);
  });

  it('refuses a state it never issued', async () => {
    await expect(completeUserConsent('made-up', 'code', 'sa', base.fields)).rejects.toThrow(/consent_state_unknown/);
  });

  it('does not leave a pending consent behind after a failed exchange', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })));
    const before = pendingConsentCount();
    const { state } = startUserConsent(base);
    await completeUserConsent(state, 'c', 'sa', base.fields).catch(() => undefined);
    expect(pendingConsentCount()).toBe(before);
  });
});
