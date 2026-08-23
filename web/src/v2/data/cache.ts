import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Read-through cache for the phase screens.
 *
 * The problem it solves: every screen used to re-read its data on mount, so
 * walking back and forth through the flow re-scanned Dataverse, re-listed the
 * directory and re-scanned connectors every single time. That is slow, it burns
 * the customer's API quota, and it loses work in progress — a pairing you just
 * made flickered back to "Choose project" while the re-read was in flight.
 *
 * Now: cached values render immediately and a refresh is something you ask for.
 * `sync()` is the only thing that re-reads, and it never blanks what is on screen
 * while it runs, because replacing real data with a spinner is a regression from
 * the reader's point of view.
 *
 * Deliberately session-scoped and in sessionStorage, not localStorage: this is a
 * customer's tenant data keyed by an opaque session id, and it must not outlive
 * the browser session.
 */

const mem = new Map<string, unknown>();

function storeKey(key: string): string {
  return `csge_v2_${key}`;
}

export function readCache<T>(key: string): T | undefined {
  if (mem.has(key)) return mem.get(key) as T;
  try {
    const raw = sessionStorage.getItem(storeKey(key));
    if (raw === null) return undefined;
    const val = JSON.parse(raw) as T;
    mem.set(key, val);
    return val;
  } catch {
    // A corrupt or unreadable entry is a cache miss, never an error.
    return undefined;
  }
}

export function writeCache<T>(key: string, value: T): void {
  mem.set(key, value);
  try {
    sessionStorage.setItem(storeKey(key), JSON.stringify(value));
  } catch {
    /* private mode, or quota — the in-memory copy still works */
  }
}

/**
 * Write a value AS IF it had just been read.
 *
 * For the case where this client is the one that changed the truth: saving a
 * pairing used to leave the cached `pairs:` entry stale, so Select agents read the
 * OLD pairing, saw no paired environment, and showed an empty agent list until
 * someone pressed Sync. A write that other screens read has to update the cache
 * it wrote through.
 */
export function primeResource<T>(key: string, value: T): void {
  writeCache(key, { value, at: Date.now() });
}

/**
 * Mark a cached value out of date WITHOUT throwing it away.
 *
 * The screen that owns it re-reads on its next mount; until then the rail can still
 * say what was last true, which is the whole difference between "you finished this"
 * and a blank step number.
 */
export function markStale(session: string, key: string): void {
  const now = readProgress(session).staleKeys ?? [];
  if (!now.includes(key)) markProgress(session, { staleKeys: [...now, key] });
}

export function isStale(session: string, key: string): boolean {
  return (readProgress(session).staleKeys ?? []).includes(key);
}

export function clearStale(session: string, key: string): void {
  const now = readProgress(session).staleKeys ?? [];
  if (now.includes(key)) markProgress(session, { staleKeys: now.filter((k) => k !== key) });
}

/** Drop everything whose key starts with `prefix`. Used when a decision upstream
 *  invalidates what a later screen read (new agent selection → stale connectors). */
export function invalidateCache(prefix: string): void {
  for (const k of [...mem.keys()]) if (k.startsWith(prefix)) mem.delete(k);
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i -= 1) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(storeKey(prefix))) sessionStorage.removeItem(k);
    }
  } catch {
    /* nothing to do */
  }
}

export interface Resource<T> {
  data: T | undefined;
  /** True only on a FIRST read with nothing cached — the one case where a
   *  skeleton is honest. */
  loading: boolean;
  /** True while a sync is in flight over data already on screen. */
  syncing: boolean;
  error: string;
  /** When this data was last actually read from the server. */
  readAt?: number;
  sync: () => void;
}

interface Entry<T> { value: T; at: number }

/**
 * Cache-first resource.
 *
 * `key` must include the session id — two tenants must never share an entry.
 * `enabled` is for the screens that cannot read anything until something else
 * exists (no session, no selection).
 */
export function useResource<T>(
  key: string,
  loader: () => Promise<T>,
  enabled = true,
): Resource<T> {
  const cached = readCache<Entry<T>>(key);
  const [data, setData] = useState<T | undefined>(cached?.value);
  const [readAt, setReadAt] = useState<number | undefined>(cached?.at);
  const [loading, setLoading] = useState(enabled && cached === undefined);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState('');
  // Keep the latest loader without making it a dependency: an inline arrow
  // would re-run this on every render, which is the bug this file exists to fix.
  const loaderRef = useRef(loader);
  loaderRef.current = loader;
  const runRef = useRef(0);

  const read = useCallback(async (isSync: boolean): Promise<void> => {
    const run = ++runRef.current;
    if (isSync) setSyncing(true); else setLoading(true);
    try {
      const value = await loaderRef.current();
      if (run !== runRef.current) return; // a newer read already won
      const at = Date.now();
      writeCache<Entry<T>>(key, { value, at });
      setData(value);
      setReadAt(at);
      setError('');
    } catch (e) {
      if (run !== runRef.current) return;
      setError((e as Error).message || 'read_failed');
    } finally {
      if (run === runRef.current) { setLoading(false); setSyncing(false); }
    }
  }, [key]);

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    // Cached data is shown as-is. Nothing is re-read until someone asks.
    if (readCache<Entry<T>>(key) !== undefined) { setLoading(false); return; }
    void read(false);
  }, [key, enabled, read]);

  return { data, loading, syncing, error, readAt, sync: () => void read(true) };
}

/** "Read 4 minutes ago" — so a stale number is visibly stale rather than assumed
 *  live. Absent means it has not been read in this browser session. */
export function readAgo(at?: number): string {
  if (!at) return 'not read yet';
  const mins = Math.floor((Date.now() - at) / 60000);
  if (mins < 1) return 'read just now';
  if (mins === 1) return 'read 1 minute ago';
  if (mins < 60) return `read ${mins} minutes ago`;
  const hrs = Math.floor(mins / 60);
  return hrs === 1 ? 'read an hour ago' : `read ${hrs} hours ago`;
}


/**
 * What the operator has actually DONE, as opposed to what happens to be cached.
 *
 * The phase rail was deriving "did you map users" from the cached user list, so
 * anything that dropped that cache — picking different agents, for one — silently
 * un-ticked a phase the person had completed. A cache is a copy of a read; this is
 * a record of an act, and the two need different lifetimes.
 */
export interface Progress {
  usersMapped?: number;
  credentialsSaved?: number;
  /** Connectors that needed a human, as of the last look. Lets the rail say amber
   *  instead of falling back to a bare step number. */
  connectorsBlocked?: number;
  /** Keys whose cached value is known to be out of date. A stale read is still
   *  worth more to the rail than no read at all: deleting the connector scan when
   *  the selection changed is exactly what un-ticked a finished phase. */
  staleKeys?: string[];
  /**
   * How many connectors were on screen with NOTHING needing a human, the last time
   * the Connectors screen was looked at.
   *
   * The rail derived this phase from the connector scan alone, and the scan is
   * dropped whenever the agent selection changes — so walking back to Select agents
   * and forward again un-ticked a phase that had genuinely been finished. A scan is
   * a cached read; this is a record of having looked.
   */
  connectorsCleared?: number;
  ranAt?: number;
}

export function readProgress(session: string): Progress {
  try {
    return JSON.parse(sessionStorage.getItem(`csge_v2_progress_${session}`) || '{}') as Progress;
  } catch {
    return {};
  }
}

export function markProgress(session: string, patch: Progress): void {
  try {
    const next = { ...readProgress(session), ...patch };
    sessionStorage.setItem(`csge_v2_progress_${session}`, JSON.stringify(next));
  } catch {
    /* a lost marker costs a tick, never data */
  }
}


/**
 * The run transcript, kept outside React.
 *
 * The log lived in MigrateV2's state, so stepping back one screen and forward
 * again during a run showed an empty pane — the lines were gone with the unmounted
 * component, and the stream cannot be re-opened to replay them because GET
 * /api/migrate/stream IS the run: re-subscribing would start a second migration.
 *
 * So the transcript is written down as it arrives. A remount shows what actually
 * happened, and says plainly that it is no longer receiving live updates rather
 * than implying a dead run.
 */
export interface RunLog<L, A> {
  lines: L[];
  agents: A[];
  pct: number;
  finished: string | null;
  /** A run was started and never seen to end. Not proof it is still going — proof
   *  that nobody saw it stop. */
  live: boolean;
}

/** Bounded: a big migration emits thousands of lines and sessionStorage has a
 *  quota. The tail is the part anyone reads. */
const RUN_LOG_MAX = 400;

export function readRunLog<L, A>(session: string): RunLog<L, A> {
  const empty: RunLog<L, A> = { lines: [], agents: [], pct: 0, finished: null, live: false };
  if (!session) return empty;
  try {
    const raw = sessionStorage.getItem(`csge_v2_run_${session}`);
    return raw ? { ...empty, ...(JSON.parse(raw) as RunLog<L, A>) } : empty;
  } catch {
    return empty;
  }
}

export function writeRunLog<L, A>(session: string, patch: Partial<RunLog<L, A>>): void {
  if (!session) return;
  try {
    const next = { ...readRunLog<L, A>(session), ...patch };
    next.lines = next.lines.slice(-RUN_LOG_MAX);
    sessionStorage.setItem(`csge_v2_run_${session}`, JSON.stringify(next));
  } catch {
    /* quota or private mode — the on-screen copy still works */
  }
}
