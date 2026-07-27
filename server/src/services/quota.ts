import { config } from '../config.js';
import { getDb, isDbConnected } from '../db/core.js';

/**
 * Agent-creation quota helpers — the production handling for the per-project,
 * per-day "Agent creation quota exceeded" (RESOURCE_EXHAUSTED) limit.
 *
 * The real limit is UNDOCUMENTED and not readable via any API (the quota-usage
 * dashboard doesn't list it). So until Google Support confirms the number
 * (see docs/SUPPORT-TICKET-AGENT-QUOTA.md), the pre-flight check works off a
 * CONFIGURED cap (AGENT_CREATE_DAILY_CAP) plus a count of how many creations
 * we've already done in the current quota day (from our own DB). This lets us
 * WARN the customer before a run and PACE across the daily reset instead of
 * hard-failing mid-migration.
 *
 * Env:
 *   AGENT_CREATE_DAILY_CAP  known per-day agent-creation limit for the target
 *                           project (set from the Support answer). Unset/0 =
 *                           unknown → pre-flight informs but never blocks.
 */

/** Per-day agent-creation quotas reset at midnight Pacific Time. PT = UTC-8
 *  (PST) or UTC-7 (PDT). Google resets on the PT calendar day; we approximate
 *  the boundary at 08:00 UTC, which is midnight PST (the conservative, later
 *  boundary — during PDT the real reset is 07:00 UTC, so we never resume early). */
const RESET_HOUR_UTC = 8;

/** The next midnight-PT reset strictly after `now` (defaults to real now). */
export function nextQuotaResetUtc(now: Date = new Date()): Date {
  const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RESET_HOUR_UTC, 0, 0, 0));
  if (reset.getTime() <= now.getTime()) reset.setUTCDate(reset.getUTCDate() + 1);
  return reset;
}

/** Start of the CURRENT quota day (the most recent midnight-PT reset at or before now). */
export function currentQuotaDayStartUtc(now: Date = new Date()): Date {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), RESET_HOUR_UTC, 0, 0, 0));
  if (start.getTime() > now.getTime()) start.setUTCDate(start.getUTCDate() - 1);
  return start;
}

/** Configured daily cap, or null when unknown (env unset / non-positive). */
export function configuredDailyCap(): number | null {
  const n = Number(process.env.AGENT_CREATE_DAILY_CAP);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Count agents we've CREATED in the current quota day, per project — best-effort
 * from migrationResults (created:true). Used to estimate remaining allowance.
 * Returns 0 if the DB is unavailable (degrade, don't fail).
 */
export async function countCreatesToday(_project: string, now: Date = new Date()): Promise<number> {
  if (!isDbConnected()) return 0;
  try {
    const since = currentQuotaDayStartUtc(now);
    return await getDb(config.CSGE_DB).collection('migrationResults').countDocuments({
      created: true,
      // destination project is recorded on the run; results carry geminiAgentId.
      // We match on updatedAt within the current quota day as the creation proxy.
      updatedAt: { $gte: since },
      geminiAgentId: { $exists: true },
      // project scoping is best-effort: results don't always carry project, so we
      // over-count slightly rather than under-count (safer for a cap check).
    } as never);
  } catch {
    return 0;
  }
}

export interface PreflightResult {
  cap: number | null; // configured daily cap, or null if unknown
  usedToday: number; // creations already done this quota day (best-effort)
  remaining: number | null; // cap - usedToday, or null if unknown
  requested: number; // agents this run wants to create
  willFit: boolean; // true if unknown cap OR requested <= remaining
  fitsNow: number; // how many can be created now (requested if willFit, else remaining)
  overflow: number; // how many must wait for the next reset
  resumeAfterUtc: string | null; // when the overflow can resume (next reset), else null
  message: string; // human-readable summary for the customer
}

/**
 * Pre-flight quota estimate for a run. Never blocks — it INFORMS. With no
 * configured cap it reports "unknown" and lets the run proceed (backoff +
 * resumability remain the safety net). With a cap it tells the customer exactly
 * how many fit today and when the rest resume.
 */
export async function preflightQuota(project: string, requested: number, now: Date = new Date()): Promise<PreflightResult> {
  const cap = configuredDailyCap();
  const usedToday = cap == null ? 0 : await countCreatesToday(project, now);
  const remaining = cap == null ? null : Math.max(0, cap - usedToday);
  const willFit = remaining == null ? true : requested <= remaining;
  const fitsNow = remaining == null ? requested : Math.min(requested, remaining);
  const overflow = Math.max(0, requested - fitsNow);
  const resumeAfterUtc = overflow > 0 ? nextQuotaResetUtc(now).toISOString() : null;

  let message: string;
  if (cap == null) {
    message = `Agent-creation quota: limit unknown (set AGENT_CREATE_DAILY_CAP from Google Support). Proceeding; will pace + resume automatically if throttled.`;
  } else if (willFit) {
    message = `Agent-creation quota: ${requested} agent(s) fit within today's remaining allowance (${remaining}/${cap}).`;
  } else {
    message = `Agent-creation quota: today's remaining allowance is ${remaining}/${cap}. Will create ${fitsNow} now; ${overflow} will resume after the daily reset (${resumeAfterUtc}).`;
  }
  return { cap, usedToday, remaining, requested, willFit, fitsNow, overflow, resumeAfterUtc, message };
}
