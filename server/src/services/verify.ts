import { logger } from '../logger.js';
import { fetchTextTransient, isTransientNetworkError } from './httpTransient.js';
import { assistantBase } from './gemini.js';
import { chatWithAdkAgent } from './adkAgentChat.js';
import type { GeminiDestination } from '../types.js';

/**
 * Post-migration verification. Three levels:
 *   1. Existence — GET the created agent; confirms it persisted.
 *   2. Behaviour — ask it something and read the runtime's own tool evidence.
 *   3. Tool inventory — confirm the tools we wired are actually on the deployment.
 *
 * Never throws — verification failure must not fail the migration itself.
 * Parameterized by the destination so it checks the RIGHT engine.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: a 200 is not an answer, and `deployed=true` is
 * not `works=true`. Anything we could not establish is reported as `unknown`, never as a
 * pass.
 */

/**
 * `verified` was a two-value answer to a three-value question, which is how this module
 * used to report "we could not check" as "checked and fine".
 *
 * `unknown` is NOT a pass. `verified` is derived as `status === 'verified'`, so every
 * existing caller reading the boolean fails CLOSED on an unknown — reporting gets more
 * honest without any caller having to change first.
 */
export type VerifyStatus = 'verified' | 'failed' | 'unknown';

export interface VerifyResult {
  /** True only when `status === 'verified'`. Never true on `unknown`. */
  verified: boolean;
  status: VerifyStatus;
  sample?: string;
  note?: string;
  /** Tools observed actually firing, by name, read from the runtime's call frames. */
  toolsProven?: string[];
  /** Expected tools with no evidence of existing on the deployment. */
  toolsMissing?: string[];
}

const ok = (note: string, sample?: string, extra?: Partial<VerifyResult>): VerifyResult => ({
  verified: true,
  status: 'verified',
  note,
  sample,
  ...extra,
});

const failed = (note: string, sample?: string, extra?: Partial<VerifyResult>): VerifyResult => ({
  verified: false,
  status: 'failed',
  note,
  sample,
  ...extra,
});

/** Could not determine. Deliberately not a pass — see VerifyStatus. */
const unknown = (note: string, sample?: string): VerifyResult => ({
  verified: false,
  status: 'unknown',
  note,
  sample,
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * GET that retries only on transient network errors (not on HTTP status).
 *
 * A *thrown* fetch error (connection reset, timeout, DNS blip) is transient — it does NOT
 * mean the agent is missing, only that the read failed to complete. At enterprise scale
 * these happen routinely, so retrying prevents a good migration from being mislabeled
 * "unverified". (A non-ok HTTP status is a definitive answer and is NOT retried here.)
 *
 * This one returns the live `Response` because its only caller reads `ok`/`status` and never
 * touches the body. Anything that reads a body must use `fetchTextTransient` instead — the
 * body read is a second failure point that a guard around `fetch` alone does not cover.
 */
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
    /**
     * Tool names this agent was wired with. When supplied, the deployment is asked what
     * tools it has, and any that are absent fail verification.
     *
     * Without this, `expectsGrounding` proves only that the DATA STORES are reachable — an
     * agent can deploy with every connector tool missing and still pass every other check.
     */
    expectsTools?: string[];
  },
): Promise<VerifyResult> {
  // Level 1: existence check (retries transient network errors so a connection
  // blip doesn't mislabel a successfully-created agent as unverified).
  try {
    const res = await getRetryingTransient(`${assistantBase(dest)}/agents/${agentId}`, {
      headers: { Authorization: `Bearer ${saToken}` },
    });
    if (!res.ok) return failed(`agent not retrievable (${res.status})`);
  } catch (err) {
    logger.warn({ err, agentId }, 'verify existence check failed after retries');
    // The network failed, not the agent. Asserting either outcome would be a guess.
    return unknown('existence check could not complete (network) — status unknown');
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
      return failed(`agent did not answer: ${(r.error ?? '').slice(0, 200)}`);
    }
    // A failed tool call is definitive, whatever the model said around it.
    if (opts.expectsGrounding && r.toolError) {
      return failed(
        `knowledge retrieval failed: ${r.toolError.slice(0, 180)}`,
        (r.answer ?? '').slice(0, 200),
        { toolsProven: r.toolNames },
      );
    }
    // NO tool call is not a pass either. This is the hole that let agent 8277338168224151082
    // report `deployed · shared · verified` while every retrieval 403'd: the model answered
    // the probe from its instruction alone, so there was no error to catch. For an agent we
    // gave knowledge to, only positive evidence that a tool RETURNED DATA counts.
    if (opts.expectsGrounding && !r.toolSucceeded) {
      return failed(
        r.toolCalled
          ? 'the knowledge tool ran but returned no usable result — no successful function_response or grounding chunk in the reply'
          : 'the agent answered without retrieving anything — its knowledge tool was never called, so the data stores are unproven',
        (r.answer ?? '').slice(0, 240),
        { toolsProven: r.toolNames },
      );
    }

    const answer = r.answer ?? '';
    // A tool that 403s or errors comes back inside the answer text, not as an HTTP
    // failure — the agent politely says it cannot access its sources.
    const brokenGrounding =
      opts.expectsGrounding === true &&
      (/permission.{0,40}denied|IAM_PERMISSION_DENIED|servingConfigs\.search|403/i.test(answer) ||
        /unable to access|cannot access|could not access|no access to|knowledge sources? (are|is) (currently )?unavailable|don't have access to (my|the) knowledge/i.test(answer));
    if (brokenGrounding) {
      return failed(
        'agent responded but could not reach its knowledge sources — check the data stores are in the same project as the agent',
        answer.slice(0, 240),
        { toolsProven: r.toolNames },
      );
    }
    if (!answer.trim()) {
      return failed('agent returned an empty answer');
    }

    // Level 3: TOOL INVENTORY.
    //
    // Grounding above proves the DATA STORES are reachable and says nothing about the
    // connector tools — an agent can deploy with every Jira tool missing and pass every
    // check above. ADK bakes tools into the Reasoning Engine pickle at deploy time and no
    // API lists them, so the deployment itself has to be asked.
    if (opts.expectsTools?.length) {
      const inv = await verifyToolInventory(dest, saToken, opts, opts.expectsTools);
      if (inv.status !== 'verified') {
        return { ...inv, sample: inv.sample ?? answer.slice(0, 240) };
      }
      return ok(
        `deployed, answered a live probe, and reported all ${opts.expectsTools.length} expected tool(s)`,
        answer.slice(0, 240),
        { toolsProven: [...new Set([...(r.toolNames ?? []), ...(inv.toolsProven ?? [])])] },
      );
    }

    return ok(
      opts.expectsGrounding
        ? 'deployed, answered a live probe, and its knowledge tool returned data'
        : 'deployed and answered a live probe',
      answer.slice(0, 240),
      { toolsProven: r.toolNames },
    );
  }

  // Level 2 (non-ADK): conversational probe over the assist endpoint.
  try {
    const assistUrl = `${assistantBase(dest)}:assist`;
    const res = await fetchTextTransient(
      assistUrl,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: { text: probe }, agentId }),
      },
      { label: 'verify: assist' },
    );
    if (!res.ok) {
      logger.warn({ agentId, err: res.error }, 'verify assist probe failed (network)');
      return unknown('deployed, but the assist probe errored — behaviour unproven');
    }
    if (res.status >= 200 && res.status < 300) {
      const json = JSON.parse(res.text) as unknown;
      const sample = extractText(json).slice(0, 240);
      // A 200 carrying no text is not an answer. The assist endpoint returns 200 for a
      // turn that produced nothing, and calling that "responded" is how a mute agent
      // passed verification.
      if (!sample.trim()) {
        return unknown('assist probe returned 200 but no answer text — nothing was proven');
      }
      return ok('deployed and answered an assist probe', sample);
    }
    // The agent RESOURCE exists — the existence check above passed — but nothing here
    // establishes that it WORKS. This used to return verified:true, which is how an agent
    // whose probe endpoint 404'd was reported to a customer as verified.
    return unknown(
      `deployed, but the assist probe was unavailable (${res.status}) — behaviour unproven`,
    );
  } catch (err) {
    logger.warn({ err, agentId }, 'verify assist probe failed');
    return unknown('deployed, but the assist probe errored — behaviour unproven');
  }
}

/**
 * Ask the deployment which tools it has, and compare against what we wired.
 *
 * Deliberately conservative about what counts as absent. The model is describing its own
 * tool schema in prose, so a name it fails to echo is weak evidence of a missing tool:
 * matching is normalised and substring-based so a cosmetic rename does not read as a
 * regression, and an unusable answer resolves to `unknown` rather than to either verdict.
 *
 * What it reliably catches is the case that actually costs a customer — an agent deployed
 * with NO tools, or with a whole connector's worth absent.
 */
async function verifyToolInventory(
  dest: GeminiDestination,
  saToken: string,
  opts: { reasoningEngineId?: string; location?: string },
  expected: string[],
): Promise<VerifyResult> {
  const r = await chatWithAdkAgent(dest.project, saToken, {
    reasoningEngineId: opts.reasoningEngineId!,
    message:
      'List the exact names of every tool and function you have available to call. ' +
      'Reply with only the names, one per line, and nothing else. ' +
      'If you have no tools at all, reply exactly: NO TOOLS',
    userId: 'cf-verify-tools',
    location: opts.location,
  });

  const answer = r.answer ?? '';
  if (!r.ok || !answer.trim()) {
    return unknown('could not read the deployed tool inventory — tools unproven');
  }

  if (/^\s*NO TOOLS\s*$/im.test(answer)) {
    return failed(
      `the deployment reports NO tools, but ${expected.length} were wired: ${expected.join(', ')}`,
      answer.slice(0, 240),
      { toolsMissing: expected },
    );
  }

  const norm = (x: string): string => x.toLowerCase().replace(/[^a-z0-9]/g, '');
  const haystack = norm(answer);
  // Names shorter than 3 normalised chars are skipped: they match by accident inside
  // longer words and would report a present tool as proven for the wrong reason.
  const missing = expected.filter((t) => {
    const n = norm(t);
    return n.length > 2 && !haystack.includes(n);
  });

  if (missing.length === expected.length) {
    return failed(
      `none of the ${expected.length} wired tool(s) are present on the deployment: ${expected.join(', ')}`,
      answer.slice(0, 240),
      { toolsMissing: missing },
    );
  }
  if (missing.length) {
    return failed(
      `${missing.length} of ${expected.length} wired tool(s) missing from the deployment: ${missing.join(', ')}`,
      answer.slice(0, 240),
      { toolsMissing: missing },
    );
  }
  return ok('all expected tools present', answer.slice(0, 240), { toolsProven: expected });
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
