import { describe, it, expect } from 'vitest';
import { connectorSecretId, legacyConnectorSecretId, connectorFieldScope } from './connectorCredentials.js';
import { credentialScope, DEFAULT_APP_USER_ID } from '../sessionStore.js';

/**
 * These are isolation tests, not formatting tests. Every assertion here is about one
 * customer being unable to reach another's credential.
 *
 * Context (measured 2026-08-12): no route sets `appUserId`, so every session in the product
 * carries the literal 'default'. On one deployment serving several customers that is a
 * single shared credential namespace.
 */

describe('credentialScope — who owns a credential', () => {
  it('uses the app user when sign-in has set one', () => {
    expect(credentialScope({ appUserId: 'acct_42', tenantId: 'aaa' })).toBe('acct_42');
  });

  // The whole point: 'default' is not an identity, it is the absence of one.
  it('falls back to the Microsoft tenant when the app user is the shared default', () => {
    expect(credentialScope({ appUserId: DEFAULT_APP_USER_ID, tenantId: 'aaa-bbb' })).toBe('ms-aaa-bbb');
    expect(credentialScope({ tenantId: 'aaa-bbb' })).toBe('ms-aaa-bbb');
  });

  it('two different Microsoft tenants never share a scope', () => {
    expect(credentialScope({ tenantId: 'tenant-a' })).not.toBe(credentialScope({ tenantId: 'tenant-b' }));
  });

  it('is the shared default only when there is nothing at all to key on', () => {
    expect(credentialScope({})).toBe(DEFAULT_APP_USER_ID);
  });
});

describe('connectorSecretId — the id two customers must not share', () => {
  it('separates the same connector field across customers', () => {
    const a = connectorSecretId('shared_confluence', 'api_token', credentialScope({ tenantId: 'tenant-a' }));
    const b = connectorSecretId('shared_confluence', 'api_token', credentialScope({ tenantId: 'tenant-b' }));
    expect(a).not.toBe(b);
    expect(a).toContain('tenant-a');
  });

  // Confluence and Jira share one Atlassian token on purpose — asking twice for the same
  // credential is what made admins paste it into both, creating two copies to rotate.
  it('keeps ONE id for connectors that share a credential group, within a customer', () => {
    const scope = credentialScope({ tenantId: 't1' });
    expect(connectorSecretId('shared_confluence', 'api_token', scope)).toBe(
      connectorSecretId('shared_jira', 'api_token', scope),
    );
  });

  // Dynamics shares the Microsoft app but has its own org_url; that must not land in the
  // shared namespace where the next Microsoft connector would overwrite it.
  it('keeps a connector-specific field out of the shared group namespace', () => {
    expect(connectorFieldScope('shared_dynamicscrmonline', 'org_url')).toBe('shared_dynamicscrmonline');
  });

  it('never produces the legacy un-scoped id', () => {
    const scoped = connectorSecretId('shared_confluence', 'api_token', credentialScope({ tenantId: 't1' }));
    expect(scoped).not.toBe(legacyConnectorSecretId('shared_confluence', 'api_token'));
  });

  it('produces a Secret Manager-safe id from an unfriendly scope', () => {
    const id = connectorSecretId('shared_confluence', 'api_token', 'ms-AAA/BBB.ccc');
    expect(id).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe('legacyConnectorSecretId — read path only', () => {
  // It exists because secrets written under it still back deployed agents. It must stay
  // reachable for READS and must never be what a write falls back to.
  it('still resolves the pre-scoping name', () => {
    expect(legacyConnectorSecretId('shared_confluence', 'api_token')).toBe('studio-enterprise-atlassian-api-token');
  });
});
