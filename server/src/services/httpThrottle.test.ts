import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fetchWithThrottleBackoff, retryAfterMs } from './httpTransient.js';

/**
 * Throttling is a wait instruction, not a failure.
 *
 * The bug these cover: Dataverse answers 429 when a service protection limit is crossed, and
 * the read path threw on it exactly like a 400 from a bad $select — turning "wait two
 * seconds" into a failed agent, and in a paged listing discarding every page already fetched.
 */

const res = (status: number, headers: Record<string, string> = {}): Response =>
  ({ status, headers: { get: (n: string) => headers[n.toLowerCase()] ?? null } }) as unknown as Response;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

/** Drive a call that sleeps between attempts to completion under fake timers. */
async function run<T>(p: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return p;
}

describe('retryAfterMs', () => {
  it('reads delta-seconds', () => {
    expect(retryAfterMs(res(429, { 'retry-after': '3' }))).toBe(3000);
  });

  it('reads an HTTP-date', () => {
    const when = new Date(Date.now() + 5000).toUTCString();
    const ms = retryAfterMs(res(429, { 'retry-after': when }));
    expect(ms).toBeGreaterThan(3000);
    expect(ms).toBeLessThanOrEqual(6000);
  });

  it('is null when the header is absent, so the caller falls back to its own curve', () => {
    expect(retryAfterMs(res(429))).toBeNull();
  });

  it('never returns a negative wait for a date already past', () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    expect(retryAfterMs(res(429, { 'retry-after': past }))).toBe(0);
  });
});

describe('fetchWithThrottleBackoff', () => {
  it('retries a 429 and returns the eventual success', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(429, { 'retry-after': '1' }))
      .mockResolvedValueOnce(res(200));
    vi.stubGlobal('fetch', f);

    const r = await run(fetchWithThrottleBackoff('https://x', {}, { baseMs: 10 }));

    expect(r.status).toBe(200);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 the same way — it is the other throttling answer', async () => {
    const f = vi.fn().mockResolvedValueOnce(res(503)).mockResolvedValueOnce(res(200));
    vi.stubGlobal('fetch', f);

    const r = await run(fetchWithThrottleBackoff('https://x', {}, { baseMs: 10 }));

    expect(r.status).toBe(200);
  });

  it('does NOT retry a 400 — a bad $select repeats identically, so retrying only adds latency', async () => {
    const f = vi.fn().mockResolvedValue(res(400));
    vi.stubGlobal('fetch', f);

    const r = await run(fetchWithThrottleBackoff('https://x', {}, { baseMs: 10 }));

    expect(r.status).toBe(400);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('does not retry a 404 either', async () => {
    const f = vi.fn().mockResolvedValue(res(404));
    vi.stubGlobal('fetch', f);

    await run(fetchWithThrottleBackoff('https://x', {}, { baseMs: 10 }));

    expect(f).toHaveBeenCalledTimes(1);
  });

  it('gives up after the budget and RETURNS the 429 rather than looping forever', async () => {
    const f = vi.fn().mockResolvedValue(res(429));
    vi.stubGlobal('fetch', f);

    const r = await run(fetchWithThrottleBackoff('https://x', {}, { retries: 2, baseMs: 10 }));

    // Returned, not thrown: the caller's own error path already explains a bad status, and a
    // throw here would hide which status it actually was.
    expect(r.status).toBe(429);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('caps an absurd Retry-After so a migration cannot hang on it', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(res(429, { 'retry-after': '3600' }))
      .mockResolvedValueOnce(res(200));
    vi.stubGlobal('fetch', f);

    const p = fetchWithThrottleBackoff('https://x', {}, { maxWaitMs: 50, baseMs: 10 });
    await vi.advanceTimersByTimeAsync(60);

    expect((await p).status).toBe(200);
  });
});
