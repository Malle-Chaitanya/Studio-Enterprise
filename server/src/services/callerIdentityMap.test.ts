import { describe, it, expect } from 'vitest';

/**
 * Reversing the operator's user map to answer "who is asking, in SOURCE terms".
 *
 * The map is many-to-one as filled in — alex@filefuze.co and alex@qatestagent.com both
 * legitimately point at alex@migrationn.com, because one person can hold accounts in several
 * source domains. Reversing it is therefore not a bijection, and the failure mode is silent:
 * a plain overwrite resolves the caller to whichever source address was iterated last, and
 * the agent then reads a colleague's mailbox while looking entirely normal.
 *
 * This mirrors the reduction in orchestrator.ts. It is duplicated deliberately — the logic
 * there sits inside a 3000-line function that cannot be imported, and leaving the rule
 * untested because of where it lives is how it would regress.
 */
function reverse(users: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  const ambiguous = new Set<string>();
  for (const [ms, google] of Object.entries(users)) {
    if (!google) continue;
    const dest = String(google).toLowerCase();
    const existing = out[dest];
    if (existing) {
      if (existing.toLowerCase() !== ms.toLowerCase()) ambiguous.add(dest);
      continue;
    }
    out[dest] = ms;
  }
  for (const d of ambiguous) delete out[d];
  return out;
}

describe('caller identity map (destination -> source)', () => {
  it('resolves a one-to-one mapping', () => {
    expect(reverse({ 'amelia1@filefuze.co': 'amelia1@migrationn.com' }))
      .toEqual({ 'amelia1@migrationn.com': 'amelia1@filefuze.co' });
  });

  it('DROPS a destination claimed by two different source accounts', () => {
    // The live case: ben@filefuze.co and ben@qatestagent.com both map to ben@migrationn.com.
    // Keeping either would be a coin flip decided by object key order.
    const out = reverse({
      'ben@filefuze.co': 'ben@migrationn.com',
      'ben@qatestagent.com': 'ben@migrationn.com',
    });
    expect(out['ben@migrationn.com']).toBeUndefined();
  });

  it('drops the ambiguous one WITHOUT harming the others', () => {
    const out = reverse({
      'ben@filefuze.co': 'ben@migrationn.com',
      'ben@qatestagent.com': 'ben@migrationn.com',
      'amelia1@filefuze.co': 'amelia1@migrationn.com',
    });
    expect(out['ben@migrationn.com']).toBeUndefined();
    expect(out['amelia1@migrationn.com']).toBe('amelia1@filefuze.co');
  });

  it('three sources for one destination is still just dropped', () => {
    // ron@ maps from filefuze.co, qatestagent.com and storefuze.com in the live tenant.
    const out = reverse({
      'ron@filefuze.co': 'ron@migrationn.com',
      'ron@qatestagent.com': 'ron@migrationn.com',
      'ron@storefuze.com': 'ron@migrationn.com',
    });
    expect(out['ron@migrationn.com']).toBeUndefined();
  });

  it('the same source repeated is not ambiguity', () => {
    // Re-stating one pair must not look like a conflict and cost the user their mapping.
    expect(reverse({ 'Ben@Filefuze.co': 'ben@migrationn.com', 'ben@filefuze.co': 'ben@migrationn.com' }))
      .toEqual({ 'ben@migrationn.com': 'Ben@Filefuze.co' });
  });

  it('matches on the destination case-insensitively', () => {
    const out = reverse({ 'a@src.co': 'Alex@Migrationn.com', 'b@src.co': 'alex@migrationn.com' });
    // Different case, same person — still a conflict, not two entries.
    expect(out['alex@migrationn.com']).toBeUndefined();
  });

  it('ignores unmapped people rather than inventing an entry', () => {
    expect(reverse({ 'x@src.co': '' })).toEqual({});
  });
});
