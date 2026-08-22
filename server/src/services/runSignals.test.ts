import { describe, it, expect, vi } from 'vitest';
import { emitToolEnd, emitToolStart } from './runSignals.js';
import type { ProgressEvent } from '../types.js';

/**
 * `ok` is a two-value field answering a three-value question, which is the same shape of
 * mistake as `verified` before it gained `verifyStatus`.
 *
 * A verification that could not be established is not a verification that failed. Rounding
 * unknown to `true` gives an unproven agent a green tick; rounding it to `false` reports a
 * check nobody ran as a defect somebody caused. Both are wrong, and the collapse is easy to
 * reintroduce because `ok: boolean` looks complete on its own — which is exactly why it is
 * pinned here rather than left to a comment.
 */
describe('tool_end carries three values, not two', () => {
  const capture = (): { emit: (e: ProgressEvent) => void; events: ProgressEvent[] } => {
    const events: ProgressEvent[] = [];
    return { emit: (e) => events.push(e), events };
  };

  it('reports success as ok:true / outcome:ok', () => {
    const { emit, events } = capture();
    emitToolEnd(emit, 'publish', true, 'Published');
    expect(events[0]).toMatchObject({ type: 'tool_end', ok: true, outcome: 'ok' });
  });

  it('reports a real failure as ok:false / outcome:failed', () => {
    const { emit, events } = capture();
    emitToolEnd(emit, 'share', false, 'Share failed');
    expect(events[0]).toMatchObject({ ok: false, outcome: 'failed' });
  });

  it('reports unknown as outcome:unknown, and NEVER as ok:true', () => {
    // The green tick is the thing being prevented. A consumer that only reads `ok` must
    // fail closed — showing an unproven step as passed is the one outcome that misleads a
    // customer about whether their migration worked.
    const { emit, events } = capture();
    emitToolEnd(emit, 'verify', 'unknown', 'Verification inconclusive');
    expect(events[0]).toMatchObject({ ok: false, outcome: 'unknown' });
  });

  it('lets a consumer tell failed from unknown, which `ok` alone cannot', () => {
    const { emit, events } = capture();
    emitToolEnd(emit, 'verify', false, 'failed');
    emitToolEnd(emit, 'verify', 'unknown', 'inconclusive');
    const [a, b] = events as Array<Extract<ProgressEvent, { type: 'tool_end' }>>;
    expect(a.ok).toBe(b.ok); // indistinguishable on `ok`
    expect(a.outcome).not.toBe(b.outcome); // distinguishable on `outcome`
  });

  it('emits a start event carrying the target hint verbatim', () => {
    const { emit, events } = capture();
    emitToolStart(emit, 'deploy', 'Building', 'agent:abc-123');
    expect(events[0]).toMatchObject({ type: 'tool_start', tool: 'deploy', target: 'agent:abc-123' });
  });

  it('omits target when there is none rather than inventing one', () => {
    // An unresolvable target is a hint the consumer ignores; a WRONG target points the UI at
    // an unrelated row, which is worse than pointing at nothing.
    const { emit, events } = capture();
    emitToolStart(emit, 'deploy', 'Building');
    expect((events[0] as { target?: string }).target).toBeUndefined();
  });
});

describe('awaiting_human persistence', () => {
  it('emits the event even when the session write fails', async () => {
    // A Mongo outage must not swallow the handoff for whoever is watching right now. The
    // persistence is a refresh convenience; the event is the actual signal.
    vi.resetModules();
    vi.doMock('../sessionStore.js', () => ({
      updateSession: vi.fn(async () => {
        throw new Error('mongo down');
      }),
      unsetSessionFields: vi.fn(async () => undefined),
    }));
    const { emitAwaitingHuman } = await import('./runSignals.js');
    const events: ProgressEvent[] = [];
    await emitAwaitingHuman((e) => events.push(e), 'sess-1', {
      reason: 'acl_acknowledgement_required',
      msg: 'Needs acknowledgement',
    });
    expect(events[0]).toMatchObject({ type: 'awaiting_human', reason: 'acl_acknowledgement_required' });
    vi.doUnmock('../sessionStore.js');
  });
});
