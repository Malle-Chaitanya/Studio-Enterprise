import { describe, it, expect } from 'vitest';
import { pickCredentialRecord } from './applicationIntegration.js';

const OURS = { project: 'studio-enterprise-migration', secretIds: { tenant_id: 't' } };
const THEIRS = { project: 'agentmigrations', secretIds: { tenant_id: 't' } };

describe('pickCredentialRecord', () => {
  it('prefers the destination project even when another record is listed first', () => {
    // The live GetRateSheetBand failure: registry order put our project first, the DWD
    // caller is 403 there, and the AuthConfig failed with the readable copy sitting unused.
    expect(pickCredentialRecord([OURS, THEIRS], 'agentmigrations')).toBe(THEIRS);
  });

  it('still prefers the destination project when it is already first', () => {
    expect(pickCredentialRecord([THEIRS, OURS], 'agentmigrations')).toBe(THEIRS);
  });

  it('falls back to the first record when none is in the destination project', () => {
    // A run that has not copied credentials yet must still work for an identity that can
    // reach the source project — the service account's own token can.
    expect(pickCredentialRecord([OURS], 'agentmigrations')).toBe(OURS);
  });

  it('returns undefined when there is nothing stored', () => {
    expect(pickCredentialRecord([], 'agentmigrations')).toBeUndefined();
  });

  it('does not match on a project that merely shares a prefix', () => {
    const lookalike = { project: 'agentmigrations-staging', secretIds: { tenant_id: 't' } };
    expect(pickCredentialRecord([lookalike], 'agentmigrations')).toBe(lookalike);
    expect(pickCredentialRecord([lookalike, THEIRS], 'agentmigrations')).toBe(THEIRS);
  });
});
