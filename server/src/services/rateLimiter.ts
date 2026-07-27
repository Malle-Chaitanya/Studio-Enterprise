/**
 * Client-side token-bucket rate limiter for Gemini (Discovery Engine) WRITE
 * calls. Prevents 429 bursts at the source — every write acquires a token first,
 * so requests are paced to a steady rate with a small burst allowance. Backoff
 * (in gemini.ts / geminiDataStore.ts) stays as the safety net for the rare 429
 * that still slips through (e.g. another client sharing the project quota).
 *
 * Tunable via env — size to the project's real write quota when known:
 *   GEMINI_WRITE_RPS   sustained writes/sec  (default 3)
 *   GEMINI_WRITE_BURST bucket capacity        (default 5)
 */

class TokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(private readonly capacity: number, private readonly refillPerSec: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsedSec = (now - this.lastRefill) / 1000;
    if (elapsedSec > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.refillPerSec);
      this.lastRefill = now;
    }
  }

  /** Resolve once a token is available (paces callers to the configured rate). */
  async acquire(): Promise<void> {
    // The refill + check + decrement below runs synchronously (no await between),
    // so concurrent callers can't double-spend a token in Node's event loop.
    for (;;) {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(15, Math.ceil((deficit / this.refillPerSec) * 1000));
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
}

const num = (v: string | undefined, dflt: number): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : dflt;
};

/** Shared limiter for all Discovery Engine write calls in a process. */
export const geminiWriteLimiter = new TokenBucket(
  num(process.env.GEMINI_WRITE_BURST, 5),
  num(process.env.GEMINI_WRITE_RPS, 3),
);
