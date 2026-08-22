import { describe, it, expect, beforeEach } from 'vitest';
import {
  runKeyFor,
  startRun,
  publish,
  subscribe,
  stopRun,
  isStopRequested,
  isRunning,
  describeRun,
  finishRun,
} from './runRegistry.js';
import type { ProgressEvent } from '../types.js';

/**
 * The registry exists because `GET /api/migrate/stream` used to BE the run. That single
 * conflation produced three defects, and each one is pinned here because each is easy to
 * reintroduce by "simplifying" the route back to a for-await over runMigration.
 *
 * The costly one is the re-run: on 2026-08-22 a user's single button press produced three
 * complete extract passes against a live tenant, because EventSource reconnects on its own
 * when the server closes the response at the end of a run.
 */

const key = (n: string) => runKeyFor('tenant-a', `sess-${n}`);
const log = (msg: string): ProgressEvent => ({ type: 'log', level: 'info', msg });

describe('one run per session', () => {
  beforeEach(() => {
    for (const n of ['1', '2', '3', '4', '5', '6', '7']) finishRun(key(n));
  });

  it('refuses a second start while one is live — this is the re-run guard', () => {
    expect(startRun(key('1'), 'tenant-a')).toBeDefined();
    // A reconnecting EventSource lands exactly here. Starting again would re-execute the
    // whole migration against the live tenant.
    expect(startRun(key('1'), 'tenant-a')).toBeUndefined();
  });

  it('allows a new run once the previous one finished', () => {
    startRun(key('2'), 'tenant-a');
    finishRun(key('2'));
    expect(startRun(key('2'), 'tenant-a')).toBeDefined();
  });

  it('keys runs per session, so one tenant\'s two sessions do not block each other', () => {
    expect(startRun(key('3'), 'tenant-a')).toBeDefined();
    expect(startRun(key('4'), 'tenant-a')).toBeDefined();
  });
});

describe('detaching a viewer never stops the work', () => {
  it('keeps the run live after every subscriber leaves', () => {
    const k = key('5');
    finishRun(k);
    startRun(k, 'tenant-a');
    const a = subscribe(k, () => {});
    a?.unsubscribe();
    // Navigating away is a statement about the viewer, not an instruction to abandon a
    // migration that is part-way through writing to a customer's Gemini project.
    expect(isRunning(k)).toBe(true);
    expect(describeRun(k)?.subscribers).toBe(0);
  });

  it('replays what a returning subscriber missed, in order', () => {
    const k = key('6');
    finishRun(k);
    startRun(k, 'tenant-a');
    publish(k, log('one'));
    publish(k, log('two'));

    const seen: string[] = [];
    const attached = subscribe(k, (e) => seen.push((e as { msg: string }).msg));
    // History arrives as replay, not as live events, so a remounted screen rebuilds in
    // order instead of showing an empty log for a run that is still going.
    expect(attached?.replay.map((e) => (e as { msg: string }).msg)).toEqual(['one', 'two']);
    expect(seen).toEqual([]);

    publish(k, log('three'));
    expect(seen).toEqual(['three']);
  });

  it('delivers to every attached subscriber and to none that left', () => {
    const k = key('7');
    finishRun(k);
    startRun(k, 'tenant-a');
    const a: string[] = [];
    const b: string[] = [];
    const subA = subscribe(k, (e) => a.push((e as { msg: string }).msg));
    subscribe(k, (e) => b.push((e as { msg: string }).msg));
    subA?.unsubscribe();
    publish(k, log('after-detach'));
    expect(a).toEqual([]);
    expect(b).toEqual(['after-detach']);
  });
});

describe('stop is cooperative and honest', () => {
  it('reports false when there is no run, rather than pretending it stopped one', () => {
    const k = runKeyFor('tenant-a', 'sess-nothing-here');
    expect(stopRun(k)).toBe(false);
  });

  it('is idempotent — asking twice is not an error', () => {
    const k = runKeyFor('tenant-a', 'sess-stop-twice');
    finishRun(k);
    startRun(k, 'tenant-a');
    expect(stopRun(k)).toBe(true);
    expect(stopRun(k)).toBe(true);
    expect(isStopRequested(k)).toBe(true);
  });

  it('sets a flag the orchestrator reads, rather than killing anything itself', () => {
    const k = runKeyFor('tenant-a', 'sess-flag');
    finishRun(k);
    startRun(k, 'tenant-a');
    expect(isStopRequested(k)).toBe(false);
    stopRun(k);
    // Cooperative: the run is still live and finishes the agent in flight. An immediate
    // kill would leave a half-created Gemini agent no later run could reason about.
    expect(isRunning(k)).toBe(true);
    expect(describeRun(k)?.phase).toBe('stopping');
  });

  it('refuses to stop a run that already finished', () => {
    const k = runKeyFor('tenant-a', 'sess-finished');
    finishRun(k);
    startRun(k, 'tenant-a');
    finishRun(k);
    expect(stopRun(k)).toBe(false);
  });
});

describe('publishing to an unknown run is a no-op, not a crash', () => {
  it('drops events for a run that aged out', () => {
    expect(() => publish(runKeyFor('tenant-a', 'sess-gone'), log('x'))).not.toThrow();
  });

  it('returns undefined when subscribing to a run that does not exist', () => {
    expect(subscribe(runKeyFor('tenant-a', 'sess-absent'), () => {})).toBeUndefined();
  });

  it('survives a subscriber that throws', () => {
    const k = runKeyFor('tenant-a', 'sess-throwing');
    finishRun(k);
    startRun(k, 'tenant-a');
    const ok: string[] = [];
    subscribe(k, () => {
      throw new Error('broken consumer');
    });
    subscribe(k, (e) => ok.push((e as { msg: string }).msg));
    // A broken viewer must never take down the migration it is watching.
    expect(() => publish(k, log('still delivered'))).not.toThrow();
    expect(ok).toEqual(['still delivered']);
  });
});
