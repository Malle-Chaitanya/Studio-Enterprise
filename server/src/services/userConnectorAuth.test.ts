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

/** Build an unsigned JWT whose payload carries `email` — the shape a provider returns. */
function idToken(email: string): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'none' })}.${b64({ email })}.sig`;
}

function tokenResponse(body: Record<string, unknown>) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

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


/**
 * WHO the provider authenticated, versus who the link SAID it was for.
 *
 * A consent URL is just a URL. Forward it, or open it while signed in as someone else, and
 * the refresh token that comes back belongs to a different human than the one it would be
 * filed under — after which the migrated tool acts as the wrong person, silently and
 * forever. This is the same failure per-user credentials exist to prevent, reached from the
 * opposite direction, so it is checked rather than trusted.
 */
describe('consent identity binding', () => {
  beforeEach(() => { upsertSecret.mockReset(); });

  it('refuses when the provider authenticated a different person', async () => {
    const { state } = startUserConsent(base);
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse({
      refresh_token: 'rt', id_token: idToken('someone.else@filefuze.co'),
    })));
    await expect(completeUserConsent(state, 'code', 'sa', base.fields))
      .rejects.toThrow('consent_identity_mismatch');
    // The decisive assertion: nothing was written. A refusal that still stored the token
    // would be worse than no check at all.
    expect(upsertSecret).not.toHaveBeenCalled();
  });

  it('accepts when the provider confirms the expected person, case-insensitively', async () => {
    const { state } = startUserConsent(base);
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse({
      refresh_token: 'rt', id_token: idToken('ERIK@FileFuze.co'),
    })));
    const out = await completeUserConsent(state, 'code', 'sa', base.fields);
    expect(out.identityVerified).toBe(true);
    expect(upsertSecret).toHaveBeenCalledTimes(1);
  });

  it('stores but reports UNVERIFIED when the provider returns no id_token', async () => {
    const { state } = startUserConsent(base);
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse({ refresh_token: 'rt' })));
    const out = await completeUserConsent(state, 'code', 'sa', base.fields);
    // Not a failure — some providers issue none. But it must not be reported as verified;
    // the UI needs to be able to tell the two apart.
    expect(out.identityVerified).toBe(false);
    expect(upsertSecret).toHaveBeenCalledTimes(1);
  });

  it('treats an unreadable id_token as unverified, never as a match', async () => {
    const { state } = startUserConsent(base);
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse({
      refresh_token: 'rt', id_token: 'not.a.jwt',
    })));
    const out = await completeUserConsent(state, 'code', 'sa', base.fields);
    expect(out.identityVerified).toBe(false);
  });

  it('a mismatched consent still consumes its state, so it cannot be retried', async () => {
    const { state } = startUserConsent(base);
    vi.stubGlobal('fetch', vi.fn(async () => tokenResponse({
      refresh_token: 'rt', id_token: idToken('wrong@filefuze.co'),
    })));
    await expect(completeUserConsent(state, 'code', 'sa', base.fields)).rejects.toThrow();
    await expect(completeUserConsent(state, 'code', 'sa', base.fields))
      .rejects.toThrow('consent_state_unknown');
  });
});
