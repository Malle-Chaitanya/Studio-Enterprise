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
