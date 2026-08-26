import { logger } from '../logger.js';

/**
 * One HTTP request treated as a single unit: send it AND read its body.
 *
 * Guarding only the `fetch` call is not enough, and that gap cost a live run on 2026-08-22.
 * `fetch` resolves as soon as the response HEADERS arrive; the body is still streaming. If the
 * connection dies during the body, the throw comes from `res.text()` / `res.json()`, not from
 * `fetch`. Every call site here had a try/catch around the fetch and a bare `await res.text()`
 * on the next line, so the error walked straight past all of it:
 *
 *   TypeError: terminated
 *       at Fetch.onAborted (node:internal/deps/undici/undici:11132:53)
 *     caused by: Error: read ECONNRESET
 *
 * That killed verification of an agent that had already deployed and shared successfully — the
 * run was recorded as failed for a network blip on the operator's link, after ~4 minutes of
 * deploy work. The `:streamQuery?alt=sse` call is the most exposed of all: it is a long-lived
 * SSE body, so the window between "headers received" and "body complete" is seconds wide.
 *
 * The contract here is deliberately narrow:
 *   - A **transport failure** (nothing was learned) is retried with backoff, then reported as
 *     `{ ok: false }` — never thrown. Callers are pipeline stages; they must degrade, not crash.
 *   - An **HTTP status** is a definitive answer from the server and is NEVER retried. 404, 429
 *     and 500 all come back as `{ ok: true, status }` for the caller to interpret. Retrying a
 *     429 here would bypass the quota backoff in `rateLimiter.ts`, which owns that decision.
 */

export interface HttpTextOk {
  ok: true;
  status: number;
  text: string;
}
export interface HttpTextFailed {
  ok: false;
  /** Transport-level description. There is no status — the exchange never completed. */
  error: string;
}
export type HttpTextResult = HttpTextOk | HttpTextFailed;

/**
 * Is this a failure that says nothing about the request's validity?
 *
 * Checks the message, the `cause` chain and the errno code, because undici reports the useful
 * part on the cause: the outer error is the bare word "terminated".
 */
export function isTransientNetworkError(err: unknown): boolean {
  const cause = (err as { cause?: unknown })?.cause;
  const msg = [
    err instanceof Error ? err.message : String(err),
    cause instanceof Error ? cause.message : '',
    (cause as { code?: string })?.code ?? '',
    (err as { code?: string })?.code ?? '',
  ].join(' ');
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE|ENOTFOUND|socket hang up|fetch failed|terminated|network/i.test(
    msg,
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Send a request and read its body as text, retrying transport failures only.
 *
 * @param label short identifier for logs (e.g. `adkChat: stream_query`) — no URL, because these
 *              carry project ids and, on some endpoints, user principals.
 */
export async function fetchTextTransient(
  url: string,
  init: RequestInit,
  { retries = 3, baseMs = 500, label = 'http' }: { retries?: number; baseMs?: number; label?: string } = {},
): Promise<HttpTextResult> {
  let attempt = 0;
  for (;;) {
    try {
      const res = await fetch(url, init);
      // Inside the try on purpose — see the docblock. This is the line that actually throws.
      const text = await res.text();
      return { ok: true, status: res.status, text };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const detail = (err as { cause?: Error })?.cause?.message;
      const full = detail && detail !== msg ? `${msg}: ${detail}` : msg;
      if (attempt >= retries || !isTransientNetworkError(err)) {
        logger.warn({ label, attempt, err: full }, 'transient-retry: giving up');
        return { ok: false, error: full };
      }
      const wait = baseMs * 2 ** attempt;
      logger.warn({ label, attempt, wait, err: full }, 'transient-retry: network error, retrying');
      await sleep(wait);
      attempt++;
    }
  }
}

/**
 * How long a throttling response asked us to wait, in ms, or null if it did not say.
 *
 * `Retry-After` is either delta-seconds or an HTTP-date. Guessing shorter gets throttled
 * again immediately; guessing longer burns window the platform already told us was free, so
 * the header is always preferred over our own backoff curve when present.
 */
export function retryAfterMs(res: { headers: { get(name: string): string | null } }): number | null {
  const raw = res.headers.get('retry-after');
  if (!raw) return null;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(raw);
  return Number.isNaN(when) ? null : Math.max(0, when - Date.now());
}

/**
 * A fetch that treats THROTTLING as a wait instruction rather than an error.
 *
 * `fetchTextTransient` above retries transport failures only — a 429 reaches the caller as
 * `{ ok: true, status: 429 }`, which every caller then has to handle itself. Two already do,
 * by hand, in services/gemini.ts. This is that same logic once, so a third copy does not get
 * written for Dataverse.
 *
 * WHY 429 AND 503 ARE NOT ERRORS. Dataverse enforces service protection limits per user, per
 * environment, over a sliding window, and answers 429 with `Retry-After` when you cross one.
 * The request is not wrong and would succeed if repeated. Throwing on it — which is what the
 * Dataverse read path did — turns "wait two seconds" into a failed agent, and in a paged
 * listing it also discards every page already fetched.
 *
 * Any OTHER non-2xx is returned as-is, unretried: a 400 from a bad $select or a 404 from a
 * wrong id is a definitive answer, and retrying only adds latency to a failure that will
 * repeat identically.
 */
export async function fetchWithThrottleBackoff(
  url: string,
  init: RequestInit,
  {
    retries = 4,
    baseMs = 500,
    maxWaitMs = 60_000,
    label = 'http',
  }: { retries?: number; baseMs?: number; maxWaitMs?: number; label?: string } = {},
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    const res = await fetch(url, init);
    if (res.status !== 429 && res.status !== 503) return res;
    if (attempt >= retries) {
      logger.warn({ label, attempt, status: res.status }, 'throttle-backoff: giving up');
      return res;
    }
    // Capped: a Retry-After of an hour would otherwise hang a migration on a promise nobody
    // can cancel. Past the cap we would rather surface the throttle than silently stall.
    const wait = Math.min(retryAfterMs(res) ?? baseMs * 2 ** attempt, maxWaitMs);
    logger.warn({ label, attempt, status: res.status, wait }, 'throttle-backoff: waiting');
    await sleep(wait);
    attempt++;
  }
}
