import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { PurgeCount } from '../core.js';

/**
 * Verbatim Copilot Studio payloads, landed before any parsing (collection: rawAgents).
 *
 * WHY THIS EXISTS. Our most expensive bug class is a parser written against one tenant's
 * payload shape. Ledger §1.23: a topic-embedded `InvokeConnectorAction` was not the shape
 * the TaskDialog parser expected, so five Dataverse agents bound ZERO operations — 45 → 71
 * once fixed, +58% coverage from a blind spot found by hand, after the fact.
 * `customConnectorInventory.ts` exists for the same class of failure: nothing ever ASKED
 * the platform what was there.
 *
 * Both were only findable by looking at the raw payload. Today we cannot: `AgentIR.unmapped`
 * keeps field NAMES, not values, so re-examining what a tenant actually sent means
 * re-extracting from a live environment. Landing raw makes two things possible that are
 * impossible now:
 *
 *   1. Diffing what a parser extracted against what the payload actually contains, so a
 *      blind spot surfaces before it costs a customer coverage rather than after.
 *   2. Replaying a parser fix against that tenant's REAL payloads instead of a fixture
 *      someone invented from memory.
 *
 * CUSTOMER DATA — the constraints below are not optional (docs/connector-transform-plan.md D1):
 *
 *   - OFF BY DEFAULT **on the run path**. Nothing is written there unless
 *     `RAW_RETENTION_DAYS` > 0. The ELT sweep is the exception and always captures — see
 *     `rawLandingEnabled` and decisions.md (2026-08-25).
 *   - TTL-EXPIRED **when a window is set**. A row carries `expiresAt` and Mongo deletes it
 *     whenever `RAW_RETENTION_DAYS` > 0. At 0 the TTL is off by choice, and deletion moves
 *     from a property of the row to `purgeRawAgents`, which an operator runs and can
 *     evidence. One of the two must always be true; never neither.
 *   - TENANT-SCOPED. Keyed and indexed by `appUserId`, like every migration-scoped
 *     collection.
 *   - BEST-EFFORT. A failure here never fails an extraction. Diagnostics must not be able
 *     to break the migration they exist to explain.
 */

const COLL = 'rawAgents';

/**
 * Mongo's hard per-document ceiling is 16 MB. We cap well below it: a single agent's
 * components are normally tens of KB, so a payload approaching this is itself the finding.
 * Truncating and SAYING SO beats a write that throws and loses the row entirely — but a
 * silently truncated payload would be worse than no payload, because a later blind-spot
 * diff would read the gap as "the parser is fine, the field isn't there."
 */
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

export interface RawAgentDoc {
  appUserId: string;
  /**
   * The customer tenant the payload came from.
   *
   * `appUserId` alone does not identify a customer: one operator can connect several, and
   * counting rows by operator reported another customer's held payloads as this one's.
   * Rows landed before this field existed carry no tenant and are excluded from the counts
   * until the next sweep replaces them.
   */
  tenantId?: string;
  runId: string;
  envUrl: string;
  sourceId: string;
  sourceName: string;
  /** Verbatim `botcomponents` rows, exactly as Dataverse returned them. */
  components: unknown[];
  /** Verbatim `bots(<id>)` record fields we read (configuration, description, …). */
  botRecord?: Record<string, unknown>;
  /** Names of components excluded by the `statecode eq 0` filter. */
  disabledComponentNames?: string[];
  /** Set when the payload exceeded MAX_PAYLOAD_BYTES and components were dropped. */
  truncated?: boolean;
  /** How many components were kept when truncated (undefined when whole). */
  keptComponents?: number;
  /** Total components Dataverse returned, whether or not they were kept. */
  totalComponents: number;
  capturedAt: Date;
  /**
   * Mongo deletes the row at this instant — see the TTL index in db/mongo.ts.
   *
   * ABSENT when `RAW_RETENTION_DAYS` is 0, which switches the TTL off deliberately for an
   * engagement longer than any window. A row with no `expiresAt` is never auto-deleted, so
   * `purgeRawAgents` is the only thing that removes it. Sparse TTL index, so absent rows are
   * simply not candidates rather than being deleted immediately.
   */
  expiresAt?: Date;
}

/**
 * Whether the RUN path lands raw payloads. Unchanged: off unless the operator opted in,
 * because during a migration run raw is still only a diagnostic.
 *
 * The ELT sweep does NOT consult this. Since 2026-08-25 raw is the system of record the
 * transform reads from (decisions.md), so `saveRawAgent({ always: true })` captures
 * regardless — a config value nobody set must not silently empty the source data.
 */
export function rawLandingEnabled(): boolean {
  return config.RAW_RETENTION_DAYS > 0;
}

/** Retention window in days, for callers that report it. 0 when landing is off. */
export function rawRetentionDays(): number {
  return config.RAW_RETENTION_DAYS;
}

export interface SaveRawAgentArgs {
  appUserId: string;
  /** Which customer tenant this came from — see `RawAgentDoc.tenantId`. */
  tenantId?: string;
  /**
   * The migration run that produced this payload, or the ELT sweep id (`sweep:<iso>`) when
   * it came from the connect-time sweep, which has no run. Kept as one field rather than two
   * so the unique index stays a single key and a sweep row cannot silently duplicate a run
   * row for the same agent.
   */
  runId: string;
  /** Capture even when `rawLandingEnabled()` is false. Set by the ELT sweep only. */
  always?: boolean;
  envUrl: string;
  sourceId: string;
  sourceName: string;
  components: unknown[];
  botRecord?: Record<string, unknown>;
  disabledComponentNames?: string[];
}

/**
 * Land one agent's verbatim payload. Never throws, never blocks an extraction.
 *
 * Idempotent on (appUserId, runId, sourceId): re-running the same run replaces the row
 * rather than accumulating duplicates, matching how `stagedAgents` keys its upserts.
 */
export async function saveRawAgent(args: SaveRawAgentArgs): Promise<void> {
  if ((!args.always && !rawLandingEnabled()) || !isDbConnected()) return;
  try {
    const now = new Date();
    // Omitted entirely at 0 so the TTL index has nothing to act on. Writing a far-future
    // date instead would look like retention that expires and never would.
    const expiresAt = config.RAW_RETENTION_DAYS > 0
      ? new Date(now.getTime() + config.RAW_RETENTION_DAYS * 86_400_000)
      : undefined;

    let components = args.components;
    let truncated = false;
    let keptComponents: number | undefined;

    // Measure before writing. A payload big enough to hit the cap is a finding in its own
    // right, so it is logged rather than quietly shrunk.
    if (Buffer.byteLength(JSON.stringify(components)) > MAX_PAYLOAD_BYTES) {
      let bytes = 0;
      const kept: unknown[] = [];
      for (const c of components) {
        bytes += Buffer.byteLength(JSON.stringify(c));
        if (bytes > MAX_PAYLOAD_BYTES) break;
        kept.push(c);
      }
      components = kept;
      truncated = true;
      keptComponents = kept.length;
      logger.warn(
        { sourceId: args.sourceId, kept: kept.length, total: args.components.length },
        'rawAgents: payload over cap, components truncated',
      );
    }

    const doc: RawAgentDoc = {
      appUserId: args.appUserId,
      tenantId: args.tenantId || undefined,
      runId: args.runId,
      envUrl: args.envUrl,
      sourceId: args.sourceId,
      sourceName: args.sourceName,
      components,
      botRecord: args.botRecord,
      disabledComponentNames: args.disabledComponentNames,
      truncated: truncated || undefined,
      keptComponents,
      totalComponents: args.components.length,
      capturedAt: now,
      expiresAt,
    };

    await getDb()
      .collection<RawAgentDoc>(COLL)
      .replaceOne(
        { appUserId: args.appUserId, runId: args.runId, sourceId: args.sourceId },
        doc,
        { upsert: true },
      );
  } catch (err) {
    // Deliberately swallowed: this collection exists to explain migrations, not to gate
    // them. Logged so a silent absence of rows is still traceable to a cause.
    logger.warn({ err, sourceId: args.sourceId }, 'rawAgents: save failed (non-fatal)');
  }
}

/**
 * Landed payloads for one run, tenant-scoped.
 *
 * `appUserId` is required, not optional, and leads the filter: a query on this collection
 * without it is a cross-tenant read of customer data.
 */
export async function listRawAgents(
  appUserId: string,
  runId: string,
): Promise<RawAgentDoc[]> {
  if (!isDbConnected()) return [];
  try {
    return await getDb()
      .collection<RawAgentDoc>(COLL)
      .find({ appUserId, runId })
      .toArray();
  } catch (err) {
    logger.warn({ err, runId }, 'rawAgents: list failed (non-fatal)');
    return [];
  }
}

/** One landed payload by source id, tenant-scoped. */
export async function getRawAgent(
  appUserId: string,
  runId: string,
  sourceId: string,
): Promise<RawAgentDoc | null> {
  if (!isDbConnected()) return null;
  try {
    return await getDb()
      .collection<RawAgentDoc>(COLL)
      .findOne({ appUserId, runId, sourceId });
  } catch (err) {
    logger.warn({ err, sourceId }, 'rawAgents: get failed (non-fatal)');
    return null;
  }
}

/**
 * Delete every landed payload for one tenant, and say how many went.
 *
 * This is the deletion guarantee when the TTL is off. Decommissioning the server is NOT one:
 * Mongo's data lives in the named `csge-mongo-data` volume, and `docker compose down` leaves
 * named volumes in place unless given `-v` — so payloads survive a container rebuild, and
 * any host snapshot keeps its own copy regardless.
 *
 * Returns the deleted count so the caller can evidence it. Unlike the rest of this module it
 * DOES throw: a purge that quietly failed would be reported as a completed deletion, which is
 * worse than an error.
 */
export async function purgeRawAgents(
  appUserId: string,
  tenantId?: string,
): Promise<PurgeCount> {
  if (!isDbConnected()) throw new Error('database not connected — purge not attempted');
  const coll = getDb(config.CSGE_DB).collection(COLL);
  const scope = tenantId ? { appUserId, tenantId } : { appUserId };
  const r = await coll.deleteMany(scope);
  // Left behind ON PURPOSE when purging one tenant: a row with no tenant could belong to any
  // customer this operator has connected. Reported so the caller can say so.
  const untagged = tenantId
    ? await coll.countDocuments({ appUserId, tenantId: { $exists: false } })
    : 0;
  return { deleted: r.deletedCount ?? 0, untagged };
}

/** How many payloads are held for one tenant, and how many will never expire on their own. */
/**
 * How many payloads are held, and how many will never expire on their own.
 *
 * Scoped to ONE tenant when given one. Without it the count spans every customer the
 * operator has connected, which read as this customer's holdings on a status line — the
 * same operator-vs-customer confusion the sweep keying had.
 */
export async function rawAgentStats(
  appUserId: string,
  tenantId?: string,
): Promise<{ total: number; neverExpires: number }> {
  if (!isDbConnected()) return { total: 0, neverExpires: 0 };
  try {
    const coll = getDb(config.CSGE_DB).collection(COLL);
    const scope = tenantId ? { appUserId, tenantId } : { appUserId };
    const [total, neverExpires] = await Promise.all([
      coll.countDocuments(scope),
      coll.countDocuments({ ...scope, expiresAt: { $exists: false } }),
    ]);
    return { total, neverExpires };
  } catch (e) {
    logger.warn(`rawAgentStats failed: ${(e as Error).message}`);
    return { total: 0, neverExpires: 0 };
  }
}
