import { describe, it, expect } from 'vitest';
import { resolveCallerIdentityMap } from './callerIdentity.js';

// The live map that refused four real people on run K8F11evlDd6kpG0LLn57vKYHFCo.
const LIVE = {
  'erik@filefuze.co': 'admin@migrationn.com',
  'alex@filefuze.co': 'alex@migrationn.com',
  'ben@filefuze.co': 'ben@migrationn.com',
  'dan@fuzebot.io': 'dan@migrationn.com',
  'ron@filefuze.co': 'ron@migrationn.com',
  'alex@qatestagent.com': 'alex@migrationn.com',
  'ben@qatestagent.com': 'ben@migrationn.com',
  'dan@qatestagent.com': 'dan@migrationn.com',
  'ron@qatestagent.com': 'ron@migrationn.com',
  'ron@storefuze.com': 'ron@migrationn.com',
};

describe('resolveCallerIdentityMap', () => {
  it('resolves the live map instead of refusing four people', () => {
    const r = resolveCallerIdentityMap(LIVE, 'admin@migrationn.com');
    expect(r.dropped).toEqual([]);
    expect(r.map).toEqual({
      'admin@migrationn.com': 'erik@filefuze.co',
      'alex@migrationn.com': 'alex@filefuze.co',
      'ben@migrationn.com': 'ben@filefuze.co',
      'dan@migrationn.com': 'dan@qatestagent.com',
      'ron@migrationn.com': 'ron@filefuze.co',
    });
  });

  it("uses the operator's own source domain as primary", () => {
    // erik@filefuze.co is the admin, so filefuze.co outranks qatestagent.com even though
    // both carry the same number of mappings.
    const r = resolveCallerIdentityMap(LIVE, 'admin@migrationn.com');
    expect(r.resolved.find((x) => x.dest === 'alex@migrationn.com')).toEqual({
      dest: 'alex@migrationn.com',
      chosen: 'alex@filefuze.co',
      setAside: ['alex@qatestagent.com'],
    });
  });

  it('reports what it set aside rather than choosing silently', () => {
    const r = resolveCallerIdentityMap(LIVE, 'admin@migrationn.com');
    expect(r.resolved.find((x) => x.dest === 'ron@migrationn.com')?.setAside).toEqual([
      'ron@qatestagent.com',
      'ron@storefuze.com',
    ]);
  });

  it('still drops a tie WITHIN one domain — no ordering rule can settle that', () => {
    const r = resolveCallerIdentityMap(
      { 'alex@filefuze.co': 'alex@migrationn.com', 'alexander@filefuze.co': 'alex@migrationn.com' },
      'admin@migrationn.com',
    );
    expect(r.map['alex@migrationn.com']).toBeUndefined();
    expect(r.dropped).toEqual([
      { dest: 'alex@migrationn.com', sources: ['alex@filefuze.co', 'alexander@filefuze.co'] },
    ]);
  });

  it('falls back to mapping count when the operator is unknown', () => {
    // No operatorDest: the domain the operator mapped more often wins.
    const r = resolveCallerIdentityMap(
      {
        'a@big.co': 'a@dest.com',
        'b@big.co': 'b@dest.com',
        'c@big.co': 'c@dest.com',
        'a@small.co': 'a@dest.com',
      },
      '',
    );
    expect(r.map['a@dest.com']).toBe('a@big.co');
  });

  it('treats a restated account (different casing) as one source, not a collision', () => {
    const r = resolveCallerIdentityMap(
      { 'alex@filefuze.co': 'alex@migrationn.com', 'Alex@Filefuze.co': 'ALEX@migrationn.com' },
      '',
    );
    expect(r.dropped).toEqual([]);
    expect(r.map['alex@migrationn.com']).toBe('alex@filefuze.co');
  });

  it('is stable — same map always resolves the same way', () => {
    const a = resolveCallerIdentityMap(LIVE, 'admin@migrationn.com');
    const shuffled = Object.fromEntries(Object.entries(LIVE).reverse());
    const b = resolveCallerIdentityMap(shuffled, 'admin@migrationn.com');
    expect(b.map).toEqual(a.map);
  });

  it('ignores blank entries', () => {
    const r = resolveCallerIdentityMap({ 'a@x.co': '', '': 'b@dest.com', 'c@x.co': 'c@dest.com' }, '');
    expect(r.map).toEqual({ 'c@dest.com': 'c@x.co' });
  });
});
