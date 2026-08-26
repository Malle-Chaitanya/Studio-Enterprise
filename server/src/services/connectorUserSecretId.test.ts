import { describe, it, expect } from 'vitest';
import { connectorSecretId, connectorUserSecretId } from './connectorCredentials.js';

/**
 * Per-user credential names.
 *
 * The server writes these ids and the deployed container derives the same name at call time
 * (scripts/adk_deploy.py `_secret`). If the two ever disagree the lookup misses and every
 * tool call fails at inference behind a green deployment — so these tests pin the shape, not
 * just the behaviour.
 */
describe('per-user secret ids', () => {
  it('is the shared id plus the caller, never an independently built name', () => {
    const shared = connectorSecretId('shared_office365', 'client_id', 'tenant-a');
    const mine = connectorUserSecretId('shared_office365', 'client_id', 'tenant-a', 'erik@filefuze.co');
    // Derived, so tenant scoping and group resolution can never drift between the two.
    expect(mine.startsWith(`${shared}-u-`)).toBe(true);
    expect(mine).toBe(`${shared}-u-erik-filefuze-co`);
  });

  it('treats one person as one person regardless of how they typed their address', () => {
    const a = connectorUserSecretId('shared_office365', 'client_id', 't', 'Erik@FileFuze.co');
    const b = connectorUserSecretId('shared_office365', 'client_id', 't', 'erik@filefuze.co');
    expect(a).toBe(b);
  });

  it('keeps two users apart under the same tenant and field', () => {
    const erik = connectorUserSecretId('shared_office365', 'client_id', 't', 'erik@filefuze.co');
    const alex = connectorUserSecretId('shared_office365', 'client_id', 't', 'alex@filefuze.co');
    expect(erik).not.toBe(alex);
  });

  it('keeps the same user apart across tenants', () => {
    const a = connectorUserSecretId('shared_office365', 'client_id', 'tenant-a', 'erik@filefuze.co');
    const b = connectorUserSecretId('shared_office365', 'client_id', 'tenant-b', 'erik@filefuze.co');
    // Same human, two customers. Sharing a secret across them is a cross-tenant leak.
    expect(a).not.toBe(b);
  });

  it('refuses to build a name with no caller rather than producing a shared-looking id', () => {
    // An empty suffix would yield "…-u-", which reads as a per-user secret and behaves as a
    // shared one. Throwing keeps the ambiguity from ever reaching Secret Manager.
    expect(() => connectorUserSecretId('shared_office365', 'client_id', 't', '')).toThrow();
  });
});
