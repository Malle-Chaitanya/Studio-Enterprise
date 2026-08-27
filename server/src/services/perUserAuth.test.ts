import { describe, it, expect } from 'vitest';
import { applyPerUserAuth, perUserCredentialFields, supportsUserAuth } from './userConnectorAuth.js';

/**
 * These assert the ONE thing that cannot be caught downstream: a connector marked per-user
 * that still authenticates as the application. That deploys, runs, and answers — for every
 * caller as a single shared identity. Nothing in the pipeline flags it and no smoke test
 * sees it, which is why it is pinned here.
 */
describe('applyPerUserAuth', () => {
  it('switches a delegable connector from app auth to the caller', () => {
    const out = applyPerUserAuth({
      id: 'shared_office365',
      authKind: 'oauth2-client-credentials',
      scope: 'https://graph.microsoft.com/.default',
    });
    expect(out.perUser).toBe(true);
    expect(out.perUserFields).toEqual(['refresh_token']);
    // The whole point: client_credentials authenticates the APP, identically for everyone.
    expect(out.authKind).toBe('oauth2-refresh-token');
    expect(out.scope).not.toBe('https://graph.microsoft.com/.default');
    expect(out.scope).toContain('offline_access');
  });

  it('marks a connector with no delegated flow per-user with NO fields, so it fails closed', () => {
    const out = applyPerUserAuth({
      id: 'shared_commondataserviceforapps',
      authKind: 'oauth2-client-credentials',
    });
    expect(out.perUser).toBe(true);
    // Empty is the instruction to the container: refuse, do not fall back to shared.
    expect(out.perUserFields).toEqual([]);
    // Auth kind is left ALONE — there is no refresh token to exchange.
    expect(out.authKind).toBe('oauth2-client-credentials');
  });

  it('never leaves a per-user connector silently shared', () => {
    for (const id of ['shared_office365', 'shared_commondataserviceforapps', 'nonexistent_x']) {
      expect(applyPerUserAuth({ id }).perUser).toBe(true);
    }
  });

  it('only the refresh token is personal — app registration fields stay shared', () => {
    // client_id/client_secret identify the OAuth app. Keying them by caller would break
    // the token exchange for everyone, including users who HAD consented.
    expect(perUserCredentialFields('shared_office365')).toEqual(['refresh_token']);
    expect(perUserCredentialFields('shared_office365')).not.toContain('client_id');
    expect(perUserCredentialFields('shared_office365')).not.toContain('client_secret');
  });

  it('reports no delegated fields exactly when there is no user-auth flow', () => {
    for (const id of ['shared_office365', 'shared_commondataserviceforapps', 'nope']) {
      expect(perUserCredentialFields(id).length > 0).toBe(supportsUserAuth(id));
    }
  });
});
