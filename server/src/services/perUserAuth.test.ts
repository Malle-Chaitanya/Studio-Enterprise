import { describe, it, expect } from 'vitest';
import { applyPerUserAuth, perUserCredentialFields, supportsUserAuth } from './userConnectorAuth.js';
import { CONNECTOR_REGISTRY } from '../connectors/registry.js';

/**
 * These assert the ONE thing that cannot be caught downstream: a connector marked per-user
 * that still authenticates as the application. That deploys, runs, and answers — for every
 * caller as a single shared identity. Nothing in the pipeline flags it and no smoke test
 * sees it, which is why it is pinned here.
 */
describe('applyPerUserAuth', () => {
  it('prefers IMPERSONATION over consent where the platform supports it', () => {
    // Verified live 2026-08-31: an app-only Dataverse call carrying MSCRMCallerID is refused
    // per the IMPERSONATED user's roles, not the app's. That makes consent unnecessary here —
    // and consent is the path that dies when this tool is decommissioned.
    const out = applyPerUserAuth({ id: 'shared_commondataserviceforapps', authKind: 'oauth2-client-credentials' }) as Record<string, unknown>;
    expect(out.perUser).toBe(true);
    expect(out.perUserMode).toBe('impersonate');
    expect(out.impersonationHeader).toBe('MSCRMCallerID');
    // No per-user SECRETS: the credential stays the shared app one. Claiming otherwise would
    // send the container hunting for a secret that by design never exists, and it would then
    // fail closed for everybody.
    expect(out.perUserFields).toEqual([]);
    // And the app credential must NOT be swapped for a refresh-token grant.
    expect(out.authKind).toBe('oauth2-client-credentials');
  });

  it('still marks an impersonating connector per-user', () => {
    // The flag is what makes the container name the caller on every call. Dropping it
    // because "there are no per-user secrets" would silently run everyone as the app.
    expect(applyPerUserAuth({ id: 'shared_dynamicscrmonline' }).perUser).toBe(true);
  });

  it.skip('treats Dataverse as delegable — superseded by impersonation', () => {
    // Dataverse is 194 of the 212 invoker tools in the test tenant, so whether it is
    // delegable decides whether per-user is a feature or a footnote. user_impersonation
    // means "act as this signed-in user", which is precisely what Copilot's invoker did.
    const out = applyPerUserAuth({ id: 'shared_commondataserviceforapps', authKind: 'oauth2-client-credentials', scope: '{org_url}/.default' });
    expect(out.perUserFields).toEqual(['refresh_token']);
    expect(out.authKind).toBe('oauth2-refresh-token');
    expect(out.scope).toContain('user_impersonation');
    // Left as a TEMPLATE: the resource is per environment, resolved at consent/call time.
    expect(out.scope).toContain('{org_url}');
  });

  it('reports the two Dataverse connector ids identically', () => {
    // Same Web API behind two ids. Reporting one as fixable and the other as permanently
    // lost, purely by which id the source agent declared, would be arbitrary.
    for (const id of ['shared_commondataserviceforapps', 'shared_dynamicscrmonline']) {
      expect(perUserCredentialFields(id)).toEqual(['refresh_token']);
    }
  });

  it('impersonates for Outlook too — a mailbox has exactly one owner', () => {
    // Graph has no act-as header; it scopes by the path segment (/users/{caller}/...). Same
    // intent as MSCRMCallerID, different transport — and for a mailbox, addressing IS the
    // permission model, so a delegated token would confine nothing further.
    const out = applyPerUserAuth({
      id: 'shared_office365',
      authKind: 'oauth2-client-credentials',
      scope: 'https://graph.microsoft.com/.default',
    }) as Record<string, unknown>;
    expect(out.perUserMode).toBe('impersonate');
    expect(out.impersonationResolve).toBe('graph-user-path');
    // The app credential is NOT swapped for a refresh-token grant.
    expect(out.authKind).toBe('oauth2-client-credentials');
    expect(out.perUserFields).toEqual([]);
  });

  it('no connector currently takes the delegated path — say so out loud', () => {
    // Every connector that has userAuth also has impersonation, so the consent branch is
    // unreachable today. That is the intended outcome (consent expires and dies with this
    // tool), but it means the branch is untested by the suite. If someone adds a
    // consent-only connector, this fails and they will know to cover it.
    const delegatedOnly = CONNECTOR_REGISTRY.filter((c) => c.userAuth && !c.impersonation).map((c) => c.id);
    expect(delegatedOnly).toEqual([]);
  });

  it('marks a connector with no delegated flow per-user with NO fields, so it fails closed', () => {
    // A Copilot CUSTOM connector: not in the registry at all, which is the common shape for
    // the ones a customer built themselves (the live Sales desk agent has four).
    const out = applyPerUserAuth({
      id: 'shared_get-20crm-20objects-20from-20hubspot',
      authKind: 'oauth2-client-credentials',
    });
    expect(out.perUser).toBe(true);
    // Empty is the instruction to the container: refuse, do not fall back to shared.
    expect(out.perUserFields).toEqual([]);
    // Auth kind is left ALONE — there is no refresh token to exchange.
    expect(out.authKind).toBe('oauth2-client-credentials');
  });

  it('never leaves a per-user connector silently shared', () => {
    for (const id of ['shared_office365', 'shared_get-20crm-20objects-20from-20hubspot', 'nonexistent_x']) {
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
    for (const id of ['shared_office365', 'shared_commondataserviceforapps', 'shared_pipedrive', 'nope']) {
      expect(perUserCredentialFields(id).length > 0).toBe(supportsUserAuth(id));
    }
  });
});
