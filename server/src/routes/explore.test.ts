import { describe, it, expect } from 'vitest';
import { classifyEnvDenial } from './explore.js';

/**
 * The error strings here are verbatim from live probes (spikes/_probe_envs_403.ts,
 * 2026-08-12) against the two environments in this tenant our app cannot read. Invented
 * fixtures would only prove the classifier matches the shape I imagined.
 */
describe('classifyEnvDenial', () => {
  // Both blocked environments returned exactly this. The token acquired fine in both
  // cases — the grant is per-environment, which is the part the customer needs told.
  const live =
    'Dataverse GET bots?$select=name failed: 403 Forbidden — ' +
    '{"error":{"code":"0x80072560","message":"The user is not a member of the organization."}}';

  it('names the missing application user and gives the admin step', () => {
    const d = classifyEnvDenial(new Error(live));
    expect(d?.code).toBe('no_application_user');
    expect(d?.fix).toMatch(/Application users/);
    // The per-environment part is the whole point: a tenant-wide grant does not exist.
    expect(d?.fix).toMatch(/per-environment/);
  });

  it('matches on the Dataverse code even when the message wording changes', () => {
    expect(classifyEnvDenial(new Error('boom 0x80072560 whatever'))?.code).toBe('no_application_user');
  });

  it('falls back to forbidden for a plain 403 with no Dataverse code', () => {
    expect(classifyEnvDenial(new Error('403 Forbidden'))?.code).toBe('forbidden');
  });

  it('reports anything else as unreachable rather than guessing a fix', () => {
    const d = classifyEnvDenial(new Error('getaddrinfo ENOTFOUND contoso.crm.dynamics.com'));
    expect(d?.code).toBe('unreachable');
    expect(d?.fix).toBeUndefined();
  });

  it('does not throw on a non-Error', () => {
    expect(classifyEnvDenial(undefined)?.code).toBe('unreachable');
  });
});
