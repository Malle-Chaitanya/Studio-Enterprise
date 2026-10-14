/**
 * A validator must read the SAME field names the customer was asked to fill.
 *
 * When it does not, it fails without ever calling the vendor and its verdict reads as the
 * vendor's: "invalid_credentials — A HubSpot private app token is required" for a token
 * that was perfectly good, because the registry declares `api_key` and the validator only
 * looked for `api_token` / `access_token` / `private_app_token` (live 2026-08-13).
 *
 * These tests supply exactly what `CREDENTIAL_GROUPS` declares and assert the validator got
 * far enough to make a network call — so any future group whose key drifts from its
 * validator fails here rather than in front of a customer.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { validateConnectorCredentials } from './connectorValidator.js';
import { CREDENTIAL_GROUPS } from '../connectors/registry.js';

/** Every group field filled with a plausible value, keyed exactly as the registry declares. */
function valuesFor(groupId: string): Record<string, string> {
  const group = CREDENTIAL_GROUPS[groupId];
  const out: Record<string, string> = {};
  for (const f of group.credentials) {
    out[f.key] = f.type === 'url' ? 'https://example.atlassian.net' : `test-${f.key}`;
  }
  return out;
}

afterEach(() => vi.unstubAllGlobals());

describe('validateConnectorCredentials reads the registry’s own field keys', () => {
  it('HubSpot: accepts the declared api_key and probes the API', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await validateConnectorCredentials('shared_hubspot', valuesFor('hubspot'));

    expect(fetchMock).toHaveBeenCalled(); // it got past the "field missing" guard
    expect(res.code).toBe('ok');
    // And it sent the token it was given, rather than an empty bearer.
    const init = (fetchMock.mock.calls as unknown as unknown[][])[0][1] as RequestInit;
    expect(String((init.headers as Record<string, string>).Authorization)).toContain('test-api_key');
  });

  it('HubSpot: still reports a missing token when nothing was supplied', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const res = await validateConnectorCredentials('shared_hubspot', {});

    expect(res.code).toBe('invalid_credentials');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('HubSpot: a 401 from the vendor is reported as the vendor’s verdict', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })));

    const res = await validateConnectorCredentials('shared_hubspot', valuesFor('hubspot'));

    expect(res.code).toBe('invalid_credentials');
    expect(res.detail).toMatch(/HubSpot rejected/i);
  });

  it('HubSpot: missing scopes are permission_denied, not bad credentials', async () => {
    // These are different problems with different fixes — retyping a token never fixes a scope.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 403 })));

    const res = await validateConnectorCredentials('shared_hubspot', valuesFor('hubspot'));

    expect(res.code).toBe('permission_denied');
  });

  it('Atlassian: accepts the declared base_url/email/api_token and probes the site', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accountId: 'a1', emailAddress: 'x@y.z' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await validateConnectorCredentials('shared_confluence', valuesFor('atlassian'));

    expect(fetchMock).toHaveBeenCalled();
    expect(res.code).toBe('ok');
  });

  it('Atlassian: a 200 that identifies nobody is not a pass', async () => {
    // Atlassian answers some endpoints anonymously; a dead token would otherwise look fine.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));

    const res = await validateConnectorCredentials('shared_confluence', valuesFor('atlassian'));

    expect(res.code).toBe('invalid_credentials');
  });

describe('service-account JSON shape', () => {
  // A complete-enough key: only the three fields every Google auth path reads.
  const goodKey = JSON.stringify({
    type: 'service_account',
    project_id: 'p',
    private_key: '-----BEGIN PRIVATE KEY-----abc-----END PRIVATE KEY-----',
    client_email: 'sa@p.iam.gserviceaccount.com',
    token_uri: 'https://oauth2.googleapis.com/token',
  });

  it('rejects a key whose paste was cut short, naming the cause', async () => {
    // The real failure, 2026-10-14: the trailing ` }` was lost, the key stored silently,
    // and a deployed agent answered "authentication error" on every Gmail call hours later.
    const truncated = goodKey.slice(0, -1);

    const res = await validateConnectorCredentials('shared_gmail', { service_account_json: truncated });

    expect(res.code).toBe('invalid_credentials');
    expect(res.detail).toMatch(/not valid JSON/i);
  });

  it('rejects JSON that parses but is not a service account key', async () => {
    const res = await validateConnectorCredentials('shared_gmail', {
      service_account_json: JSON.stringify({ type: 'service_account', project_id: 'p' }),
    });

    expect(res.code).toBe('invalid_credentials');
    expect(res.detail).toMatch(/client_email/);
  });

  it('a well-formed key still reports unverified, never ok — we did not test it', async () => {
    // Shape is not proof the credential works. Claiming `ok` here would be exactly the
    // overclaiming this module exists to avoid.
    const res = await validateConnectorCredentials('shared_gmail', { service_account_json: goodKey });

    expect(res.code).toBe('unverified');
  });

  it('never looks at the field for a connector that does not carry one', async () => {
    const res = await validateConnectorCredentials('shared_gmail', {});

    expect(res.code).toBe('unverified');
  });
});

});
