import { logger } from '../logger.js';
import { assistantBase } from './gemini.js';
import { chatWithAdkAgent } from './adkAgentChat.js';
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
  /** When the agent is ADK-backed, its Reasoning Engine id. Supplying it turns
   *  verification from "the resource exists" into "the agent actually answers". */
  opts?: {
    reasoningEngineId?: string;
    location?: string;
    /** True when the agent was given knowledge sources — then the probe must actually
     *  retrieve, and a retrieval failure means the migration did not work. */
    expectsGrounding?: boolean;
  },
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

  // Level 2: ASK IT SOMETHING. An agent that exists is not an agent that works.
  //
  // This used to return verified:true whenever the resource was retrievable, which is
  // how a migrated agent whose every retrieval failed with
  // `403 discoveryengine.servingConfigs.search denied` still reported
  // "deployed · shared · verified" (2026-08-07). A verification that cannot fail tells
  // a customer nothing.
  if (opts?.reasoningEngineId) {
    // A generic "what can you help me with?" is answered from the instruction alone, so
    // it passes even when every knowledge source is unreachable — which is exactly how a
    // broken agent reported verified. When the agent is supposed to have knowledge, ask
    // something that CANNOT be answered without retrieving.
    const groundedProbe =
      'Search your knowledge sources and name one specific document, page or file you can ' +
      'actually see. If you cannot access them, say why.';
    const r = await chatWithAdkAgent(dest.project, saToken, {
      reasoningEngineId: opts.reasoningEngineId,
      message: opts.expectsGrounding ? groundedProbe : probe,
      userId: 'cf-verify',
      location: opts.location,
    });
    if (!r.ok) {
      return { verified: false, note: `agent did not answer: ${(r.error ?? '').slice(0, 200)}` };
    }
    // A failed tool call is definitive, whatever the model said around it.
    if (opts.expectsGrounding && r.toolError) {
      return {
        verified: false,
        sample: (r.answer ?? '').slice(0, 200),
        note: `knowledge retrieval failed: ${r.toolError.slice(0, 180)}`,
      };
    }
    // NO tool call is not a pass either. This is the hole that let agent 8277338168224151082
    // report `deployed · shared · verified` while every retrieval 403'd: the model answered
    // the probe from its instruction alone, so there was no error to catch. For an agent we
    // gave knowledge to, only positive evidence that a tool RETURNED DATA counts.
    if (opts.expectsGrounding && !r.toolSucceeded) {
      return {
        verified: false,
        sample: (r.answer ?? '').slice(0, 240),
        note: r.toolCalled
          ? 'the knowledge tool ran but returned no usable result — no successful function_response or grounding chunk in the reply'
          : 'the agent answered without retrieving anything — its knowledge tool was never called, so the data stores are unproven',
      };
    }

    const answer = r.answer ?? '';
    // A tool that 403s or errors comes back inside the answer text, not as an HTTP
    // failure — the agent politely says it cannot access its sources.
    const brokenGrounding =
      opts.expectsGrounding === true &&
      (/permission.{0,40}denied|IAM_PERMISSION_DENIED|servingConfigs\.search|403/i.test(answer) ||
        /unable to access|cannot access|could not access|no access to|knowledge sources? (are|is) (currently )?unavailable|don't have access to (my|the) knowledge/i.test(answer));
    if (brokenGrounding) {
      return {
        verified: false,
        sample: answer.slice(0, 240),
        note: 'agent responded but could not reach its knowledge sources — check the data stores are in the same project as the agent',
      };
    }
    if (!answer.trim()) {
      return { verified: false, note: 'agent returned an empty answer' };
    }
    return {
      verified: true,
      sample: answer.slice(0, 240),
      note: opts.expectsGrounding
        ? 'deployed, answered a live probe, and its knowledge tool returned data'
        : 'deployed and answered a live probe',
    };
  }

  // Level 2 (non-ADK): best-effort conversational probe.
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
