/**
 * Copilot Studio agent memory → Vertex AI Agent Engine Memory Bank.
 *
 * Copilot persists long-term memory in Dataverse `intelligentmemory` as SEMANTIC TRIPLES:
 * `subject` / `predicate` / `targetobject` ("user" / "prefers_summary_cadence" / "weekly,
 * Monday morning"), each with a `privacylevel` and a `ttlinseconds`. The destination,
 * Vertex Memory Bank, stores a natural-language `fact` under a free-form `scope`
 * (proven live: create → list → retrieve → delete, ledger §1.19).
 *
 * Three properties of the source shape drive every decision in this file:
 *
 * 1. **There is no agent lookup.** `intelligentmemory` has no relationship to `bot` —
 *    only a free-string `sourceid`. Memory in Copilot is about a PERSON, not about an
 *    agent. So a fact can be attributed to a migrated agent only when `sourceid` happens
 *    to carry that agent's botid; everything else is unattributed and must be reported,
 *    never quietly attached to whichever agent happened to be migrating.
 *
 * 2. **`privacylevel` is per fact.** A `Private` fact is user-only. Widening it during a
 *    migration is the same class of failure as the ACL loss on knowledge stores, except
 *    it leaks inferred personal statements rather than documents. Private facts are
 *    scoped to that one user's mapped Google identity or they are not migrated at all.
 *
 * 3. **`ttlinseconds` does not survive.** Memory Bank has no per-memory expiry. A fact
 *    Copilot would have forgotten becomes permanent, so every TTL-bearing fact carries a
 *    `needs-review` note naming the date it would have expired.
 */
import type { FidelityNote } from '../types.js';

/** One row of Dataverse `intelligentmemory`, as extracted. */
export interface MemoryFactIR {
  id: string;
  /** Who/what the memory is about ("user", an email, an account name). */
  subject: string;
  /** `_`-separated relationship, e.g. `prefers_contact_channel`. */
  predicate: string;
  /** The value being remembered. */
  targetObject: string;
  /** fact | observation | inference | … (source vocabulary, kept verbatim). */
  memoryKind?: string;
  /** short_term | long_term. */
  memoryType?: string;
  /** app | agent | user. */
  memorySource?: string;
  /** Private (user-only) | Shared | … */
  privacyLevel?: string;
  /** Seconds from creation until Copilot would drop it. */
  ttlSeconds?: number;
  /** Free-string origin id. Sometimes a botid, often not — see note 1 above. */
  sourceId?: string;
  createdOn?: string;
}

/** What one environment's memory looks like once read. */
export interface EnvironmentMemoryIR {
  envUrl: string;
  /** Facts whose `sourceId` matched a botid in this migration, keyed by botid. */
  byAgent: Map<string, MemoryFactIR[]>;
  /** Facts we cannot attribute to any migrated agent. Reported, never guessed at. */
  unattributed: MemoryFactIR[];
}

/** A memory ready to POST to Memory Bank. */
export interface MemoryBankWrite {
  fact: string;
  scope: Record<string, string>;
  /** Carried for the report, not sent. */
  sourceFactId: string;
}

/**
 * Render a triple as the sentence Memory Bank stores.
 *
 * Memory Bank retrieval is semantic, so the wording matters: `prefers_contact_channel`
 * retrieves nothing for "how should I contact them". Underscores become spaces and the
 * subject leads, which is how the fact will actually be read back to the model.
 */
export function factSentence(f: Pick<MemoryFactIR, 'subject' | 'predicate' | 'targetObject'>): string {
  const subject = f.subject.trim();
  const predicate = f.predicate.trim().replace(/_+/g, ' ');
  const target = f.targetObject.trim();
  if (!subject && !predicate) return target;
  if (!target) return `${subject} ${predicate}`.trim();
  return `${subject} ${predicate}: ${target}`;
}

/** True when the source marked this fact user-private. */
export function isPrivate(f: Pick<MemoryFactIR, 'privacyLevel'>): boolean {
  return /private/i.test(f.privacyLevel ?? '');
}

/**
 * Decide the Memory Bank scope for one fact.
 *
 * `identityMap` is the Microsoft→Google mapping the operator already made on the Map
 * Users step; reusing it is the whole reason a private memory can move at all. A private
 * fact whose owner has no mapped Google identity has nowhere safe to land: scoping it to
 * the agent would publish one person's inferred preferences to every user of that agent,
 * so it is refused rather than widened.
 */
export function scopeFor(
  f: MemoryFactIR,
  identityMap: Map<string, string>,
): { scope: Record<string, string> } | { refused: string } {
  const owner = f.subject.trim().toLowerCase();
  const mapped = identityMap.get(owner);
  if (isPrivate(f)) {
    if (!mapped) {
      return {
        refused:
          `marked ${f.privacyLevel} in Copilot and its subject "${f.subject}" has no mapped ` +
          'Google identity. Migrating it under any wider scope would expose one person\'s ' +
          'remembered details to everyone who can use the agent.',
      };
    }
    return { scope: { user_id: mapped } };
  }
  // Non-private facts still prefer a user scope when we know the user — a "Shared" fact
  // about a named person is shared with an audience, not with the world.
  return mapped ? { scope: { user_id: mapped } } : { scope: { agent_scope: 'all_users' } };
}

/**
 * Turn extracted facts into Memory Bank writes plus the notes that must accompany them.
 *
 * Pure: no network. Every fact ends up in exactly one of `writes` or `notes` — a fact
 * that is silently in neither is the failure this function exists to prevent.
 */
export function planMemoryMigration(
  facts: MemoryFactIR[],
  identityMap: Map<string, string>,
  now: Date,
): { writes: MemoryBankWrite[]; notes: FidelityNote[] } {
  const writes: MemoryBankWrite[] = [];
  const notes: FidelityNote[] = [];

  for (const f of facts) {
    const component = `memory:${f.predicate || f.id}`;
    const decided = scopeFor(f, identityMap);
    if ('refused' in decided) {
      notes.push({
        component,
        status: 'lost',
        detail: `Remembered detail about "${f.subject}" was not migrated: it is ${decided.refused}`,
      });
      continue;
    }

    writes.push({ fact: factSentence(f), scope: decided.scope, sourceFactId: f.id });

    // Everything below is a real difference between the two systems. A migrated memory
    // that behaves differently and says nothing is worse than one that did not migrate.
    if (f.ttlSeconds && f.ttlSeconds > 0) {
      const expiry = new Date((f.createdOn ? new Date(f.createdOn).getTime() : now.getTime()) + f.ttlSeconds * 1000);
      notes.push({
        component,
        status: 'needs-review',
        detail:
          `Copilot would have forgotten this on ${expiry.toISOString().slice(0, 10)} ` +
          `(TTL ${f.ttlSeconds}s). Memory Bank has no per-memory expiry, so it now persists ` +
          'until deleted.',
      });
    }
    if (/short_?term/i.test(f.memoryType ?? '')) {
      notes.push({
        component,
        status: 'needs-review',
        detail:
          'Marked short-term in Copilot. Memory Bank makes no short/long-term distinction, ' +
          'so this is retained as a durable fact.',
      });
    }
    if (/inference|observation/i.test(f.memoryKind ?? '')) {
      notes.push({
        component,
        status: 'needs-review',
        detail:
          `Recorded as an ${f.memoryKind} — something Copilot's model concluded, not something ` +
          'the user stated. It moves as an asserted fact and may no longer be true.',
      });
    }
  }

  return { writes, notes };
}

/**
 * The note that must appear when memory exists but is not attributable to any agent.
 *
 * Without this the report reads as a complete migration while the agent's entire
 * personalization stayed behind.
 */
export function unattributedMemoryNote(count: number): FidelityNote {
  return {
    component: 'memory:unattributed',
    status: 'needs-review',
    detail:
      `${count} remembered fact(s) exist in this Copilot environment that carry no agent id, ` +
      'because Copilot stores memory against the PERSON rather than the agent. They were not ' +
      'migrated to any one agent. Migrating them requires deciding which agent should hold ' +
      'them, which is a per-customer decision this tool will not make on its own.',
  };
}
