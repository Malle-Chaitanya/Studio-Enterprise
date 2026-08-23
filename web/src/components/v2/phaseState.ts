import { readCache, readProgress } from '../../v2/data/cache.ts';
import type { PhaseId, PhaseStatus } from './PhaseRail.tsx';
import type { ConnectorRow, EnvPair, UserRow } from '../../v2/data/index.ts';

/**
 * One place that decides what the rail says.
 *
 * Each screen used to declare the state of every phase itself, so the rail
 * disagreed with itself as you walked: Select agents showed three green ticks
 * behind it, Connectors showed the same three phases as untouched numbers. The
 * rail is a claim about the migration, not about the screen you happen to be on,
 * so it has to be derived from the same state everywhere.
 *
 * Every claim here comes from data actually read and cached. A phase we know
 * nothing about stays `pending` rather than being guessed either way.
 */
interface Entry<T> { value: T; at: number }

function cached<T>(key: string): T | undefined {
  return readCache<Entry<T>>(key)?.value;
}

export function derivePhaseStatus(
  session: string,
  current: PhaseId,
): Partial<Record<PhaseId, PhaseStatus>> {
  const out: Partial<Record<PhaseId, PhaseStatus>> = {};
  if (!session) return out;


  // Pairing lives on Connect now, so it colours Connect rather than a phase of its
  // own: with no environment pointed at a Gemini app, Connect is not finished.
  const pairs = cached<EnvPair[]>(`pairs:${session}`) ?? [];
  const paired = pairs.filter((p) => p.project && p.engine).length;
  const envs = cached<Array<{ accessible: boolean }>>(`envs:${session}`);
  out.connect = paired > 0
    ? {
      state: 'done',
      // Against the environments we can actually READ: counting unreachable ones
      // in the denominator makes a complete pairing look unfinished forever.
      count: envs ? `${paired}/${envs.filter((e) => e.accessible).length}` : paired,
    }
    : { state: envs ? 'needs-you' : 'done' };

  const done = readProgress(session);

  const users = cached<UserRow[]>(`users:${session}`);
  const onServer = cached<number>(`idmap:${session}`);
  if (onServer) {
    // What the server has persisted outranks anything this browser remembers: it
    // is what the migration will actually use.
    out['map-users'] = { state: 'done', count: onServer };
  } else if (done.usersMapped) {
    // An act, recorded when it happened. Survives any cache being dropped.
    out['map-users'] = { state: 'done', count: done.usersMapped };
  } else if (users) {
    const mapped = users.filter((u) => u.mapped).length;
    const referenced = users.filter((u) => u.referenced).length;
    // Mapping is optional: unmapped people mean dropped ownership, which is
    // recorded, not blocked. So this is never `needs-you`.
    out['map-users'] = mapped > 0
      ? { state: 'done', count: referenced ? `${mapped}/${referenced}` : mapped }
      : { state: 'pending' };
  }

  try {
    const local: Array<{ env: string; botIds: string[] }> =
      JSON.parse(sessionStorage.getItem(`csge_data_${session}`) || '[]');
    // The server-side plan is the fallback, and it matters: sessionStorage is per
    // TAB, so resuming a session in a new tab showed no selection and un-ticked a
    // phase the operator had finished.
    const fromPlan = cached<Array<{ env: string; botIds: string[] }>>(`sel:${session}`) ?? [];
    const count = (rows: Array<{ botIds: string[] }>): number =>
      rows.reduce((n, s) => n + (s.botIds?.length ?? 0), 0);
    const picked = Math.max(count(local), count(fromPlan));
    if (picked > 0) out['select-agents'] = { state: 'done', count: picked };
  } catch {
    /* no selection recorded yet */
  }

  const scan = cached<{ rows: ConnectorRow[] }>(`conn:${session}`);
  if (!scan && done.connectorsBlocked) {
    // Seen, and things were waiting on a person. Amber from the act.
    out.connectors = { state: 'needs-you', count: done.connectorsBlocked };
    out.migrate = { state: 'blocked' };
  } else if (!scan && done.connectorsCleared) {
    // Seen, and nothing was waiting on a person. Claimed from the act, not from a
    // scan we no longer hold.
    out.connectors = { state: 'done', count: done.connectorsCleared };
  } else if (!scan && done.credentialsSaved) {
    // Credentials were entered in this session, but the scan that would prove the
    // current state has been dropped. Say what we know — an act happened — and do
    // not claim the phase is finished, because we cannot see the rows.
    out.connectors = { state: 'done', count: done.credentialsSaved };
  } else if (scan) {
    const need = scan.rows.filter((r) => r.state === 'needs-you').length;
    out.connectors = need > 0
      ? { state: 'needs-you', count: need }
      : { state: 'done', count: scan.rows.length || undefined };
    if (need > 0) out.migrate = { state: 'blocked' };
  }

  // The screen you are on is current, whatever else we derived about it.
  out[current] = { ...out[current], state: 'current' };
  return out;
}
