import { logger } from '../logger.js';
import type { ProgressEvent } from '../types.js';

/**
 * The live runs this process owns, so a run has an identity apart from the HTTP
 * response that happened to start it.
 *
 * Why this exists. `GET /api/migrate/stream` used to BE the run: opening it called
 * runMigration, and that single conflation produced three separate defects.
 *
 *   1. A reconnect re-ran everything. EventSource auto-reconnects when the server
 *      closes the response at the end of a run, the session still held the plan, and
 *      the whole migration executed again — three full extract passes against a live
 *      tenant from one button press.
 *   2. Navigating away threw the run's output on the floor. `execute()` was always a
 *      detached promise, so the MIGRATION survived (no half-written agents, which is
 *      the one mercy here) but every event after the unmount went into a queue nobody
 *      drained. Come back and the screen showed an empty log for a run still going.
 *   3. Nothing could stop a run. There was no handle to signal — the only "stop" was
 *      closing the stream, which stopped the watching, not the work.
 *
 * So: the registry owns the run, and the stream becomes a pure observer that can
 * attach, replay what it missed, detach, and re-attach. Closing a stream is no longer
 * an instruction about the migration.
 *
 * In-process and deliberately not persisted. A restart already has a truthful answer
 * for runs it no longer owns — `reconcileInterruptedRuns()` marks them `interrupted` at
 * boot — and persisting live subscriber state would only invent a second source of
 * truth for something the DB already records. See db/repos/migrations.ts.
 */

/** Replay depth. Enough to rebuild the log pane on a remount without unbounded growth. */
const MAX_BUFFERED_EVENTS = 5000;

export type RunPhase = 'running' | 'stopping' | 'finished';

interface LiveRun {
  runKey: string;
  appUserId: string;
  startedAt: number;
  phase: RunPhase;
  /** Everything emitted so far, for replay to a late or returning subscriber. */
  events: ProgressEvent[];
  /** True once the buffer dropped events, so a replay can admit it is partial. */
  truncated: boolean;
  subscribers: Set<(e: ProgressEvent) => void>;
  /** Set by stopRun(); the orchestrator reads it at safe points and winds down. */
  stopRequested: boolean;
  stopRequestedBy?: string;
}

const runs = new Map<string, LiveRun>();

/**
 * One active run per session. That is the same invariant the pipeline already relies on
 * — re-migrating must never duplicate — expressed where it can actually be enforced,
 * rather than left to the browser not reconnecting.
 */
export function runKeyFor(appUserId: string, sessionId: string): string {
  return `${appUserId}::${sessionId}`;
}

export function getRun(runKey: string): LiveRun | undefined {
  return runs.get(runKey);
}

/** Is a run for this session still going? Used to attach instead of starting a second. */
export function isRunning(runKey: string): boolean {
  const r = runs.get(runKey);
  return !!r && r.phase !== 'finished';
}

/**
 * Register a run that is about to start.
 *
 * Returns undefined when one is already live for this session — the caller must attach
 * to that one rather than starting another. This is the re-run guard, and it lives here
 * rather than in the route so every future caller inherits it.
 */
export function startRun(runKey: string, appUserId: string): LiveRun | undefined {
  if (isRunning(runKey)) return undefined;
  const run: LiveRun = {
    runKey,
    appUserId,
    startedAt: Date.now(),
    phase: 'running',
    events: [],
    truncated: false,
    subscribers: new Set(),
    stopRequested: false,
  };
  runs.set(runKey, run);
  return run;
}

/**
 * Record an event and fan it out to whoever is watching right now.
 *
 * Buffering happens whether or not anyone is subscribed — that is the whole point. A
 * subscriber that arrives late gets the history; one that leaves costs the run nothing.
 */
export function publish(runKey: string, e: ProgressEvent): void {
  const run = runs.get(runKey);
  if (!run) return;
  run.events.push(e);
  if (run.events.length > MAX_BUFFERED_EVENTS) {
    run.events.splice(0, run.events.length - MAX_BUFFERED_EVENTS);
    run.truncated = true;
  }
  for (const s of run.subscribers) {
    try {
      s(e);
    } catch (err) {
      // A broken subscriber must never take down the run it is watching.
      logger.warn({ err }, 'runRegistry: subscriber threw; dropping that delivery');
    }
  }
}

/**
 * Watch a run, receiving everything it has already emitted first.
 *
 * `replay` is delivered synchronously before any live event, so a remounted screen
 * rebuilds in order and cannot interleave history with what is arriving now.
 */
export function subscribe(
  runKey: string,
  onEvent: (e: ProgressEvent) => void,
): { replay: ProgressEvent[]; truncated: boolean; unsubscribe: () => void } | undefined {
  const run = runs.get(runKey);
  if (!run) return undefined;
  const replay = run.events.slice();
  run.subscribers.add(onEvent);
  return {
    replay,
    truncated: run.truncated,
    unsubscribe: () => {
      run.subscribers.delete(onEvent);
      // Deliberately does NOT end the run. Detaching is about this viewer, not the work.
    },
  };
}

/**
 * Ask a run to stop at its next safe point.
 *
 * Cooperative on purpose. Killing mid-agent would leave a half-created Gemini agent that
 * no later run could reason about, so the orchestrator finishes whatever single agent is
 * in flight and then winds down — the same reason a failed insert is retryable.
 *
 * Returns false when there is nothing running to stop, so a caller can say "already
 * finished" instead of pretending it did something.
 */
export function stopRun(runKey: string, requestedBy?: string): boolean {
  const run = runs.get(runKey);
  if (!run || run.phase === 'finished') return false;
  if (run.stopRequested) return true; // idempotent: asking twice is not an error
  run.stopRequested = true;
  run.stopRequestedBy = requestedBy;
  run.phase = 'stopping';
  logger.info(`run ${runKey} stop requested${requestedBy ? ` by ${requestedBy}` : ''}`);
  return true;
}

/** The orchestrator's read of the stop flag, checked at agent boundaries. */
export function isStopRequested(runKey: string): boolean {
  return !!runs.get(runKey)?.stopRequested;
}

/**
 * Mark a run finished and release its subscribers.
 *
 * The buffer is kept for a short grace period rather than dropped immediately: a browser
 * reconnecting a second after the final `done` should read the ending, not find nothing
 * and conclude the run vanished.
 */
const FINISHED_RETENTION_MS = 5 * 60_000;

export function finishRun(runKey: string): void {
  const run = runs.get(runKey);
  if (!run) return;
  run.phase = 'finished';
  run.subscribers.clear();
  setTimeout(() => {
    // Only evict if nothing started a NEW run under this key in the meantime.
    if (runs.get(runKey) === run) runs.delete(runKey);
  }, FINISHED_RETENTION_MS).unref?.();
}

/** Snapshot for a status endpoint — never the raw object, which callers could mutate. */
export function describeRun(runKey: string): {
  phase: RunPhase;
  startedAt: number;
  eventCount: number;
  truncated: boolean;
  subscribers: number;
  stopRequested: boolean;
} | undefined {
  const run = runs.get(runKey);
  if (!run) return undefined;
  return {
    phase: run.phase,
    startedAt: run.startedAt,
    eventCount: run.events.length,
    truncated: run.truncated,
    subscribers: run.subscribers.size,
    stopRequested: run.stopRequested,
  };
}
