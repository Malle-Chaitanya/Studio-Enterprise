import {
  clientCredsToken, discoverEnvironments, graphTokenFromRefresh, listGraphUsersFiltered,
} from '../auth/microsoft.js';
import { mapPoolCollect } from '../concurrency.js';
import { logger } from '../logger.js';
import { cacheExtractedIR } from '../db/repos/agentIR.js';
import { rawAgentStats, rawRetentionDays, saveRawAgent } from '../db/repos/rawAgents.js';
import { getSweepResult, saveSweepResult } from '../db/repos/eltSweeps.js';
import { saveSourceUsers } from '../db/repos/sourceUsers.js';
import { extractAgent, listBots } from './dataverse.js';

/**
 * ELT — fetch every agent from every environment ONCE, land it in Mongo, and let the
 * transform read from there instead of from Dataverse.
 *
 * WHY THIS SHAPE (decisions.md, 2026-08-25). The pipeline used to re-read Dataverse at
 * every stage: the explore screen listed agents, selection re-listed them, the run
 * extracted them again. Each read is quota against the customer's tenant for data that
 * had not changed. Landing once and reading Mongo removes all of it.
 *
 * "Extract, Load, Transform" is meant literally, and the ORDER is the point. Raw payloads
 * land BEFORE parsing (`rawAgents`), so a parser fixed next month can be replayed against
 * what the tenant actually sent rather than against a fixture someone wrote from memory.
 * That is not hypothetical: ledger 1.23 cost five agents every bound operation (45 -> 71,
 * +58% coverage) because a topic-embedded `InvokeConnectorAction` was not the shape the
 * parser expected, and it was only findable from the raw payload.
 *
 * THE SWEEP IS BEST-EFFORT, ALWAYS. It runs in the background off the back of a connect,
 * so nothing a user is waiting on depends on it. One unreachable environment must not cost
 * the other nine, and a Mongo outage must not fail the connect that triggered it.
 *
 * WHAT IT DOES NOT DO. It never touches Gemini. The two-phase boundary
 * (architecture-boundaries.md) still holds: this is EXTRACT and LOAD only, and the staging
 * handoff into INSERT is unchanged. A sweep is not a migration and produces no
 * `MappedAgent` — see `cacheExtractedIR` for why that field is deliberately left alone.
 */

/**
 * The `runId` every sweep row is written under. CONSTANT, and that is the whole point.
 *
 * `rawAgents` is unique on {appUserId, runId, sourceId}. The migration path is safe because a
 * run's id is fixed for its lifetime, so re-writing an agent replaces its row. A sweep id
 * derived from the clock does the opposite: each sweep mints a new key, so nothing is ever
 * replaced and every sweep adds a COMPLETE second copy of every payload. With the sweep
 * firing on each connect and `RAW_RETENTION_DAYS=0` meaning nothing expires, that grows
 * without bound — multi-MB unredacted payloads, forever.
 *
 * A sweep is a snapshot of what the source looks like NOW, so one row per agent is the
 * correct shape. The timestamped `sweepId` still identifies the sweep in the RESULT; it just
 * must never be part of the storage key.
 */
const SWEEP_ROW_KEY = 'elt-sweep';

/** Environments swept in parallel. Each one is a separate tenant-side quota bucket. */
const ENV_CONCURRENCY = 3;

/**
 * Agents in flight per environment. Deliberately below the migration run's pool: a sweep is
 * background work triggered by a connect, and must not compete with a migration the customer
 * is actually watching.
 *
 * Lowered 4 -> 2 once the throttling picture was clear. Dataverse's service protection limits
 * are per user per ENVIRONMENT, so the environment fan-out above costs nothing — this is the
 * number that concentrates load on one bucket, and `extractAgent` issues several paged reads
 * per agent on top. Retry handles the burst you did not predict; this is the one you did, and
 * wall-clock on a job nobody is watching is the cheapest thing here to spend.
 */
const AGENT_CONCURRENCY = 2;

export interface SweepEnvResult {
  envUrl: string;
  envName: string;
  agents: number;
  landed: number;
  failed: number;
  /**
   * The agents that did NOT land, by source id and name.
   *
   * A count alone is not actionable, and it is actively misleading here: the whole ELT
   * premise is that everything downstream reads Mongo, so an agent that never landed is a
   * hole in the source data rather than a failed step someone will see again later. Naming
   * them is what makes a re-sweep able to target just those.
   */
  failures?: Array<{ sourceId: string; name: string; reason: string }>;
  /** Set when the environment could not be read at all — token, permission, or network. */
  error?: string;
}

export interface SweepResult {
  sweepId: string;
  /** Which customer tenant this describes — one operator may have several connected. */
  tenantId: string;
  startedAt: string;
  finishedAt: string;
  environments: SweepEnvResult[];
  totalAgents: number;
  totalLanded: number;
  totalFailed: number;
  retentionDays: number;
  /** Payloads now held for this tenant, and how many will never expire on their own. */
  held: { total: number; neverExpires: number };
}

/**
 * Monotonic suffix for `sweepId`. Two sweeps started in the same millisecond produced the
 * same ISO timestamp and therefore the same id — harmless today, since the id only labels a
 * result, but an identifier that can repeat is one someone eventually keys on.
 */
let sweepSeq = 0;

/**
 * In-flight sweeps, keyed by appUserId AND tenantId.
 *
 * appUserId alone was wrong: one operator can connect several customer tenants, and keying
 * on them alone meant a sweep for tenant B joined the in-flight sweep for tenant A, returned
 * A's result, and left B's agents never fetched — with nothing on screen saying so. The
 * de-duplication is meant to stop the SAME work running twice, not to stop different tenants
 * running at all.
 */
const sweepKey = (appUserId: string, tenantId: string): string => `${appUserId}:${tenantId}`;

const running = new Map<string, Promise<SweepResult>>();

/**
 * Last finished sweep, cached in this process. Mongo is the source of truth (repos/eltSweeps)
 * — this only saves a round trip for a status poll that lands on the instance that swept.
 */
const lastResult = new Map<string, SweepResult>();

export function sweepInFlight(appUserId: string, tenantId: string): boolean {
  return running.has(sweepKey(appUserId, tenantId));
}

/**
 * The last sweep for this tenant, from memory if this process ran it and from Mongo if it
 * did not. A restart or a second instance must not turn "swept an hour ago" into "never
 * swept".
 */
export async function lastSweep(
  appUserId: string,
  tenantId: string,
): Promise<SweepResult | null> {
  return (
    lastResult.get(sweepKey(appUserId, tenantId))
    ?? (await getSweepResult<SweepResult>(appUserId, tenantId))
  );
}

/**
 * Sweep one environment. Never throws — a failure is reported on the result row so the
 * caller can say WHICH environment was missed rather than returning a short list that looks
 * complete.
 */
async function sweepEnvironment(
  appUserId: string,
  tenantId: string,
  env: { url: string; name: string },
): Promise<SweepEnvResult> {
  const row: SweepEnvResult = {
    envUrl: env.url,
    envName: env.name,
    agents: 0,
    landed: 0,
    failed: 0,
  };
  let token: string;
  try {
    // App-only, matching every other extraction path. Delegated Dynamics consent is what
    // triggers AADSTS65001 (security-rules.md) — do not cross these.
    token = await clientCredsToken(tenantId, env.url);
  } catch (e) {
    row.error = `token: ${(e as Error).message}`;
    return row;
  }

  let bots: Awaited<ReturnType<typeof listBots>>;
  try {
    bots = await listBots(env.url, token);
  } catch (e) {
    row.error = `listBots: ${(e as Error).message}`;
    return row;
  }
  row.agents = bots.length;

  await mapPoolCollect(bots, AGENT_CONCURRENCY, async (bot) => {
    try {
      const ir = await extractAgent(env.url, token, bot, (raw) => {
        // `always: true` is the ELT contract: raw is the source the transform reads from,
        // so capture cannot be conditional on a retention flag. See rawAgents.ts.
        void saveRawAgent({
          appUserId,
          tenantId,
          runId: SWEEP_ROW_KEY,
          always: true,
          envUrl: raw.envUrl,
          sourceId: raw.sourceId,
          sourceName: raw.sourceName,
          components: raw.components,
          botRecord: raw.botRecord,
          disabledComponentNames: raw.disabledComponentNames,
        });
      });
      await cacheExtractedIR(appUserId, env.url, ir, { tenantId });
      row.landed++;
    } catch (e) {
      // One agent's parse failure is a finding about that agent, not a reason to abandon
      // the environment. The raw payload has already landed either way, which is the
      // whole point of landing it first.
      row.failed++;
      (row.failures ??= []).push({
        sourceId: bot.botid,
        name: bot.name,
        reason: (e as Error).message,
      });
      logger.warn(
        { err: e, envUrl: env.url, sourceId: bot.botid },
        'elt sweep: agent extract failed (payload still landed)',
      );
    }
  });

  return row;
}

/**
 * Sweep every environment in the tenant.
 *
 * De-duplicated per tenant: a second call while one is in flight joins the running sweep
 * rather than starting a competing one. Two concurrent sweeps would double the tenant's
 * quota spend to produce identical rows.
 */
export async function runEltSweep(
  appUserId: string,
  tenantId: string,
  /**
   * The Microsoft refresh token, when the caller has one. Without it the agent sweep still
   * runs — only the user snapshot is skipped, and Map users falls back to reading Graph live
   * rather than showing nothing.
   */
  msRefreshToken?: string,
): Promise<SweepResult> {
  const key = sweepKey(appUserId, tenantId);
  const existing = running.get(key);
  if (existing) return existing;

  const task = (async (): Promise<SweepResult> => {
    const startedAt = new Date();
    const sweepId = `sweep:${startedAt.toISOString()}#${++sweepSeq}`;
    logger.info({ appUserId, tenantId, sweepId }, 'elt sweep: starting');

    let envs: { url: string; name: string }[] = [];
    try {
      envs = (await discoverEnvironments(tenantId)).map((e) => ({ url: e.url, name: e.name }));
    } catch (e) {
      logger.warn({ err: e, tenantId }, 'elt sweep: environment discovery failed');
    }

    // Users and agents in parallel: neither needs the other, and the user snapshot is one
    // Graph read against a different service, so serialising them only adds latency.
    const [environments] = await Promise.all([
      mapPoolCollectEnvs(appUserId, tenantId, envs),
      snapshotSourceUsers(appUserId, tenantId, msRefreshToken),
    ]);
    const finishedAt = new Date();

    const result: SweepResult = {
      sweepId,
      tenantId,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      environments,
      totalAgents: environments.reduce((n, e) => n + e.agents, 0),
      totalLanded: environments.reduce((n, e) => n + e.landed, 0),
      totalFailed: environments.reduce((n, e) => n + e.failed, 0),
      retentionDays: rawRetentionDays(),
      held: await rawAgentStats(appUserId, tenantId),
    };

    // Landing unredacted customer payloads is never a silent side effect — the run path
    // announces it too (orchestrator.ts). At 0 the wording says plainly that nothing will
    // expire on its own, because that is the case where someone has to run the purge.
    logger.info(
      { appUserId, sweepId, ...result.held },
      result.retentionDays > 0
        ? `elt sweep: ${result.totalLanded}/${result.totalAgents} landed across ` +
          `${environments.length} environment(s), payloads auto-delete after ${result.retentionDays} day(s)`
        : `elt sweep: ${result.totalLanded}/${result.totalAgents} landed across ` +
          `${environments.length} environment(s), retention is OFF — payloads persist until purged`,
    );

    lastResult.set(key, result);
    await saveSweepResult(appUserId, tenantId, result);
    return result;
  })().finally(() => running.delete(key));

  running.set(key, task);
  return task;
}

/**
 * Snapshot the source tenant's mappable users. Best-effort, like everything else here: a
 * failed snapshot leaves Map users reading Graph live, which is what it did before.
 */
async function snapshotSourceUsers(
  appUserId: string,
  tenantId: string,
  msRefreshToken?: string,
): Promise<void> {
  if (!msRefreshToken) return;
  try {
    const token = await graphTokenFromRefresh(tenantId, msRefreshToken);
    if (!token) return;
    // Same call and same defaults the /ms-users route uses, so the snapshot and a live read
    // can never disagree about who is mappable.
    const { users, stats } = await listGraphUsersFiltered(token, { max: 999 });
    await saveSourceUsers(appUserId, tenantId, {
      users: users.map((u) => ({
        id: u.id,
        email: u.email,
        displayName: u.displayName,
        userPrincipalName: u.userPrincipalName,
      })),
      filter: stats as unknown as Record<string, unknown>,
      truncated: users.length >= 999,
    });
    logger.info({ appUserId, count: users.length }, 'elt sweep: source users snapshotted');
  } catch (e) {
    logger.warn({ err: e, appUserId }, 'elt sweep: source user snapshot failed (non-fatal)');
  }
}

/** Environments in a bounded pool, each already failure-isolated by `sweepEnvironment`. */
async function mapPoolCollectEnvs(
  appUserId: string,
  tenantId: string,
  envs: { url: string; name: string }[],
): Promise<SweepEnvResult[]> {
  return mapPoolCollect(envs, ENV_CONCURRENCY, (env) =>
    sweepEnvironment(appUserId, tenantId, env));
}

/**
 * Fire a sweep without waiting for it. Used by the connect path.
 *
 * The rejection handler is not decoration: an unhandled rejection from a background promise
 * takes the process down under Node's default policy, so a failed sweep would crash the
 * server it was meant to quietly warm.
 */
export function startEltSweepInBackground(
  appUserId: string,
  tenantId: string,
  msRefreshToken?: string,
): void {
  void runEltSweep(appUserId, tenantId, msRefreshToken).catch((e) => {
    logger.warn({ err: e, appUserId }, 'elt sweep: failed');
  });
}
