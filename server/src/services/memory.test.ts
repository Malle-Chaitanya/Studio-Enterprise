/**
 * Memory mapping rules. All fixtures are synthesized triples in the shape Dataverse
 * documents — no customer memory content is copied into this repo.
 */
import { describe, expect, it } from 'vitest';
import {
  factSentence,
  isPrivate,
  planMemoryMigration,
  scopeFor,
  unattributedMemoryNote,
  type MemoryFactIR,
} from './memory.js';

const NOW = new Date('2026-08-12T00:00:00Z');

function fact(over: Partial<MemoryFactIR> = {}): MemoryFactIR {
  return {
    id: 'm1',
    subject: 'ana@source.example',
    predicate: 'prefers_contact_channel',
    targetObject: 'email, not chat',
    privacyLevel: 'Shared',
    ...over,
  };
}

const MAP = new Map([['ana@source.example', 'ana@dest.example']]);

describe('factSentence', () => {
  it('reads as a sentence, not a database row', () => {
    expect(factSentence(fact())).toBe('ana@source.example prefers contact channel: email, not chat');
  });

  it('survives a missing target', () => {
    expect(factSentence({ subject: 'user', predicate: 'is_admin', targetObject: '' })).toBe('user is admin');
  });

  it('falls back to the value when there is no subject or predicate', () => {
    expect(factSentence({ subject: '', predicate: '', targetObject: 'renewal is in March' })).toBe(
      'renewal is in March',
    );
  });
});

describe('privacy', () => {
  it('detects the source privacy vocabulary', () => {
    expect(isPrivate({ privacyLevel: 'Private (user-only)' })).toBe(true);
    expect(isPrivate({ privacyLevel: 'Shared' })).toBe(false);
    expect(isPrivate({})).toBe(false);
  });

  it('scopes a private fact to the mapped user', () => {
    const got = scopeFor(fact({ privacyLevel: 'Private (user-only)' }), MAP);
    expect(got).toEqual({ scope: { user_id: 'ana@dest.example' } });
  });

  it('REFUSES a private fact whose subject has no mapped identity, rather than widening it', () => {
    const got = scopeFor(fact({ privacyLevel: 'Private (user-only)' }), new Map());
    expect('refused' in got).toBe(true);
  });

  it('never widens a private fact to the whole agent', () => {
    const { writes } = planMemoryMigration(
      [fact({ privacyLevel: 'Private (user-only)' })],
      new Map(),
      NOW,
    );
    expect(writes).toHaveLength(0);
  });

  it('scopes an unmapped non-private fact to the agent', () => {
    const got = scopeFor(fact({ subject: 'acme corp' }), MAP);
    expect(got).toEqual({ scope: { agent_scope: 'all_users' } });
  });
});

describe('planMemoryMigration', () => {
  it('accounts for every fact — nothing is silently dropped', () => {
    const facts = [
      fact({ id: 'a' }),
      fact({ id: 'b', privacyLevel: 'Private (user-only)', subject: 'nobody@source.example' }),
      fact({ id: 'c', ttlSeconds: 86400 }),
    ];
    const { writes, notes } = planMemoryMigration(facts, MAP, NOW);
    const accounted = new Set([...writes.map((w) => w.sourceFactId), ...notes.map((n) => n.component)]);
    expect(accounted.size).toBeGreaterThan(0);
    // b is refused, a and c are written.
    expect(writes.map((w) => w.sourceFactId).sort()).toEqual(['a', 'c']);
    expect(notes.some((n) => n.status === 'lost')).toBe(true);
  });

  it('names the date a TTL fact would have expired', () => {
    const { notes } = planMemoryMigration(
      [fact({ ttlSeconds: 172800, createdOn: '2026-08-10T00:00:00Z' })],
      MAP,
      NOW,
    );
    const ttl = notes.find((n) => n.detail.includes('would have forgotten'));
    expect(ttl?.detail).toContain('2026-08-12');
    expect(ttl?.status).toBe('needs-review');
  });

  it('flags an inference as something the model concluded, not something the user said', () => {
    const { notes } = planMemoryMigration([fact({ memoryKind: 'inference' })], MAP, NOW);
    expect(notes.some((n) => n.detail.includes('may no longer be true'))).toBe(true);
  });

  it('flags short-term memory becoming durable', () => {
    const { notes } = planMemoryMigration([fact({ memoryType: 'short_term' })], MAP, NOW);
    expect(notes.some((n) => n.detail.includes('durable fact'))).toBe(true);
  });

  it('writes nothing and notes nothing when there is no memory', () => {
    expect(planMemoryMigration([], MAP, NOW)).toEqual({ writes: [], notes: [] });
  });
});

describe('unattributedMemoryNote', () => {
  it('says the facts stayed behind and why', () => {
    const note = unattributedMemoryNote(7);
    expect(note.detail).toContain('7 remembered fact(s)');
    expect(note.detail).toContain('against the PERSON');
    expect(note.status).toBe('needs-review');
  });
});
