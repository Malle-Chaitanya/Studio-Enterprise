import { logger } from '../logger.js';
import { updateSession, unsetSessionFields } from '../sessionStore.js';
import type { AwaitingHuman, ProgressEvent } from '../types.js';

/**
 * Emitters for the three run signals a UI can act on, rather than merely print.
 *
 * The rule these exist to keep: an event describes work that ALREADY HAPPENED. A UI is
 * entitled to move a cursor, claim attention or block a screen on these, so emitting one
 * speculatively — on a timer, or because a step is "about to" run — turns the interface into
 * an animation of something that may never occur. `log` remains the right event for anything
 * narrative; these three are for things that are true.
 *
 * `target` is a hint naming a `data-agent-target` in the DOM. The server cannot know what
 * the client rendered, so an unresolvable target must be ignored silently by the consumer,
 * never treated as an error.
 */

type Emit = (e: ProgressEvent) => void;

/** A tool call began. */
export function emitToolStart(emit: Emit, tool: string, msg: string, target?: string): void {
  emit({ type: 'tool_start', tool, target, msg });
}

/**
 * A tool call ended.
 *
 * `outcome` takes the three-value answer directly — `true`, `false`, or `'unknown'` — because
 * a caller that can only say ok/not-ok has to round "could not establish" to one of them, and
 * both roundings are wrong: `true` is the green tick this pipeline refuses to give an
 * unproven agent, and `false` reports a check nobody ran as a defect somebody caused.
 *
 * `ok` is still emitted as a plain boolean, and an unknown sends `ok: false`, so a consumer
 * that never reads `outcome` fails CLOSED rather than showing a pass.
 */
export function emitToolEnd(
  emit: Emit,
  tool: string,
  outcome: boolean | 'unknown',
  msg: string,
  target?: string,
): void {
  emit({
    type: 'tool_end',
    tool,
    target,
    ok: outcome === true,
    outcome: outcome === true ? 'ok' : outcome === false ? 'failed' : 'unknown',
    msg,
  });
}

/**
 * The run stopped and needs a person.
 *
 * Emits the event AND records it on the session, because the event lives only in the SSE
 * stream: reload the page and the stream is gone, leaving a run that looks idle rather than
 * one that is waiting on you. Persistence is best-effort like every other write here — a
 * Mongo outage must not turn a handoff into a crash, so a failed write degrades to
 * "the event was still delivered to anyone currently watching".
 */
export async function emitAwaitingHuman(
  emit: Emit,
  sessionId: string | undefined,
  h: { reason: string; msg: string; target?: string },
): Promise<void> {
  emit({ type: 'awaiting_human', reason: h.reason, target: h.target, msg: h.msg });
  if (!sessionId) return;
  const awaitingHuman: AwaitingHuman = { ...h, since: Date.now() };
  try {
    await updateSession(sessionId, { awaitingHuman });
  } catch (err) {
    logger.warn({ err, reason: h.reason }, 'runSignals: could not persist awaiting_human');
  }
}

/**
 * The handoff is resolved — the operator acted, or the run moved past it.
 *
 * Must be called on every path that leaves the waiting state, including the one where the
 * next run simply starts. A stale `awaitingHuman` is worse than none: it tells the operator
 * to act on something already dealt with, and once that has happened twice nobody believes
 * the indicator again.
 */
export async function clearAwaitingHuman(sessionId: string | undefined): Promise<void> {
  if (!sessionId) return;
  try {
    await unsetSessionFields(sessionId, ['awaitingHuman']);
  } catch (err) {
    logger.warn({ err }, 'runSignals: could not clear awaiting_human');
  }
}
