import { logger } from '../logger.js';
import { assistantBase } from './gemini.js';
import type { GeminiDestination } from '../types.js';

/**
 * Post-migration verification. Two levels:
 *   1. Existence/deploy check — GET the created agent; confirms it persisted.
 *   2. Best-effort conversational smoke test via the assistant assist endpoint;
 *      captures a short sample reply when the API permits it.
 *
 * Never throws — verification failure must not fail the migration itself.
 * Parameterized by the destination so it checks the RIGHT engine.
 */

export interface VerifyResult {
  verified: boolean;
  sample?: string;
  note?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A *thrown* fetch error (connection reset, timeout, DNS blip) is transient —
 * it does NOT mean the agent is missing, only that the read failed to complete.
 * At enterprise scale these happen routinely, so retrying prevents a good
 * migration from being mislabeled "unverified". (A non-ok HTTP status is a
 * definitive answer and is NOT retried here.)
 */
function isTransientNetworkError(err: unknown): boolean {
  const cause = (err as { cause?: unknown })?.cause;
  const msg = [
    err instanceof Error ? err.message : String(err),
    cause instanceof Error ? cause.message : '',
    (cause as { code?: string })?.code ?? '',
  ].join(' ');
  return /ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|EPIPE|socket hang up|fetch failed|network/i.test(msg);
}

/** GET that retries only on transient network errors (not on HTTP status). */
async function getRetryingTransient(
  url: string,
  init: RequestInit,
  { retries = 3, baseMs = 500 } = {},
): Promise<Response> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (attempt >= retries || !isTransientNetworkError(err)) throw err;
      const wait = baseMs * 2 ** attempt;
      logger.warn({ err, attempt, wait }, 'verify: transient network error, retrying');
      await sleep(wait);
      attempt++;
    }
  }
}

export async function verifyAgent(
  dest: GeminiDestination,
  saToken: string,
  agentId: string,
  probe = 'Briefly, what can you help me with?',
): Promise<VerifyResult> {
  // Level 1: existence check (retries transient network errors so a connection
  // blip doesn't mislabel a successfully-created agent as unverified).
  try {
    const res = await getRetryingTransient(`${assistantBase(dest)}/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    if (!res.ok) return { verified: false, note: `agent not retrievable (${res.status})` };
  } catch (err) {
    logger.warn({ err, agentId }, 'verify existence check failed after retries');
    return { verified: false, note: 'existence check errored (network)' };
  }

  // Level 2: best-effort conversational probe.
  try {
    const assistUrl = `${assistantBase(dest)}:assist`;
    const res = await fetch(assistUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: { text: probe }, agentId }),
    });
    if (res.ok) {
      const json = (await res.json()) as unknown;
      const sample = extractText(json).slice(0, 240);
      return { verified: true, sample: sample || undefined, note: 'deployed and responded' };
    }
    // The agent exists and deployed even if the assist probe isn't available.
    return { verified: true, note: `deployed (assist probe unavailable: ${res.status})` };
  } catch (err) {
    logger.warn({ err, agentId }, 'verify assist probe failed');
    return { verified: true, note: 'deployed (assist probe errored)' };
  }
}

/** Pull the first meaningful text string out of an unknown assist response. */
function extractText(node: unknown): string {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) {
    for (const item of node) {
      const t = extractText(item);
      if (t) return t;
    }
    return '';
  }
  if (node && typeof node === 'object') {
    for (const [k, v] of Object.entries(node)) {
      if ((k === 'text' || k === 'content' || k === 'answer') && typeof v === 'string' && v.trim()) {
        return v;
      }
      const t = extractText(v);
      if (t) return t;
    }
  }
  return '';
}
