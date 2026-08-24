import { describe, it, expect } from 'vitest';
import { resolvePrincipal, suggestMappings } from './identityMap.js';
import type { IdentityMapOverrides, PrincipalRef } from '../types.js';

/**
 * The five real-world identity mapping shapes this repo migrates against
 * (Microsoft tenant domain -> Google Workspace domain almost never match):
 *
 *   1. same domain both sides         erik@filefuze.co   -> erik@filefuze.co
 *   2/3. different domain, same user  erik@filefuze.co   -> erik@migrationn.com  (default, no override needed)
 *   4. customer reassigns to another  erik@filefuze.co   -> admin@migrationn.com (explicit override, wins over auto-map)
 *   5. no destination can be found    erik@filefuze.co   -> (unmatched, surfaced — never silently dropped)
 *
 * A wrong auto-map here means one person's Gemini access lands on a different
 * real person, so every case that ISN'T a confident single match must resolve
 * to 'unmatched' rather than guess.
 */

const noOverrides: IdentityMapOverrides = { users: {}, groups: {} };
const user = (email: string): PrincipalRef => ({ type: 'user', id: email, email, displayName: email });

describe('resolvePrincipal — user identity mapping', () => {
  it('case 1: same domain, real Workspace account -> auto-matches (email-match)', () => {
    const r = resolvePrincipal(user('erik@filefuze.co'), {
      ownedDomains: ['filefuze.co'],
      overrides: noOverrides,
      knownGoogleUsers: ['erik@filefuze.co'],
      destinationDomains: ['filefuze.co'],
    });
    expect(r.via).toBe('email-match');
    expect(r.google).toEqual({ type: 'user', email: 'erik@filefuze.co' });
  });

  it('case 2/3: different domain, same username -> auto-matches by default (username-match)', () => {
    const r = resolvePrincipal(user('erik@filefuze.co'), {
      ownedDomains: ['filefuze.co', 'migrationn.com'],
      overrides: noOverrides,
      knownGoogleUsers: ['erik@migrationn.com'],
      destinationDomains: ['migrationn.com'],
    });
    expect(r.via).toBe('username-match');
    expect(r.google).toEqual({ type: 'user', email: 'erik@migrationn.com' });
  });

  it('case 4: explicit override to a DIFFERENT person always wins over the auto-map', () => {
    const r = resolvePrincipal(user('erik@filefuze.co'), {
      ownedDomains: ['filefuze.co', 'migrationn.com'],
      overrides: { users: { 'erik@filefuze.co': 'admin@migrationn.com' }, groups: {} },
      knownGoogleUsers: ['erik@migrationn.com', 'admin@migrationn.com'],
      destinationDomains: ['migrationn.com'],
    });
    expect(r.via).toBe('override');
    expect(r.google).toEqual({ type: 'user', email: 'admin@migrationn.com' });
  });

  it('case 5: no account under the same username anywhere -> unmatched, with a reason, never dropped', () => {
    const r = resolvePrincipal(user('erik@filefuze.co'), {
      ownedDomains: ['filefuze.co', 'migrationn.com'],
      overrides: noOverrides,
      knownGoogleUsers: ['someoneelse@migrationn.com'],
      destinationDomains: ['migrationn.com'],
    });
    expect(r.via).toBe('unmatched');
    expect(r.google).toBeUndefined();
    expect(r.reason).toBeTruthy();
  });

  it('ambiguous username across multiple destination domains -> unmatched, never guesses which one', () => {
    const r = resolvePrincipal(user('erik@filefuze.co'), {
      ownedDomains: ['filefuze.co', 'migrationn.com', 'otherdest.com'],
      overrides: noOverrides,
      knownGoogleUsers: ['erik@migrationn.com', 'erik@otherdest.com'],
      destinationDomains: ['migrationn.com', 'otherdest.com'],
    });
    expect(r.via).toBe('unmatched');
    expect(r.google).toBeUndefined();
    expect(r.reason).toMatch(/more than one/);
  });

  it('unreadable directory -> no cross-domain guess is attempted (stays same-domain email-match-unverified)', () => {
    const r = resolvePrincipal(user('erik@filefuze.co'), {
      ownedDomains: ['filefuze.co', 'migrationn.com'],
      overrides: noOverrides,
      knownGoogleUsers: undefined,
      destinationDomains: ['migrationn.com'],
    });
    expect(r.via).toBe('email-match-unverified');
    expect(r.google).toEqual({ type: 'user', email: 'erik@filefuze.co' });
  });

  it('source domain not owned at all -> unmatched, cross-domain matching never runs for outsiders', () => {
    const r = resolvePrincipal(user('erik@unrelated-external.com'), {
      ownedDomains: ['filefuze.co', 'migrationn.com'],
      overrides: noOverrides,
      knownGoogleUsers: ['erik@migrationn.com'],
      destinationDomains: ['migrationn.com'],
    });
    expect(r.via).toBe('unmatched');
    expect(r.google).toBeUndefined();
  });
});

describe('suggestMappings — Map Users pre-fill', () => {
  it('proposes a cross-domain username match for the customer to review', () => {
    const suggested = suggestMappings(
      [user('alex@filefuze.co')],
      ['filefuze.co', 'migrationn.com'],
      noOverrides,
      ['alex@migrationn.com'],
      ['migrationn.com'],
    );
    expect(suggested.users['alex@filefuze.co']).toBe('alex@migrationn.com');
  });

  it('never auto-picks an ambiguous cross-domain match — leaves it out for manual selection', () => {
    const suggested = suggestMappings(
      [user('alex@filefuze.co')],
      ['filefuze.co', 'migrationn.com', 'otherdest.com'],
      noOverrides,
      ['alex@migrationn.com', 'alex@otherdest.com'],
      ['migrationn.com', 'otherdest.com'],
    );
    expect(suggested.users['alex@filefuze.co']).toBeUndefined();
  });

  it('does not override an existing customer-entered mapping', () => {
    const suggested = suggestMappings(
      [user('alex@filefuze.co')],
      ['filefuze.co', 'migrationn.com'],
      { users: { 'alex@filefuze.co': 'admin@migrationn.com' }, groups: {} },
      ['alex@migrationn.com'],
      ['migrationn.com'],
    );
    expect(suggested.users['alex@filefuze.co']).toBe('admin@migrationn.com');
  });
});
