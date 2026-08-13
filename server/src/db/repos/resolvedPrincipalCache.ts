import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';

/**
 * Durable cache of Gemini Enterprise access state for a resolved principal
 * (collection: resolvedPrincipalCache). Distinct from `identityMappings`:
 * that collection holds the customer's manual override map (source → Google
 * identity); this one caches the RESULT of checking whether a given Google
 * identity already holds a license and the engine-scoped agentspaceUser role,
 * so a person shared on ten agents in the same run — or across separate runs
 * — is checked once, not once per agent. Keyed by appUserId + tenantId +
 * engine + googleEmail, since license/role state is meaningful per
 * destination engine, not globally.
 *
 * Modeled on the sibling content-migration product's MappingCache/
 * PermissionCache pattern (see docs/content-migration-db-design.md) — but
 * unlike that product, this cache exists for audit/durability, not raw API
 * call volume: identityMap.ts's resolution is already a cheap pure function.
 * The expensive, rate-limited calls are the License/EngineRole checks this
 * cache is actually protecting.
 */

const COLL = 'resolvedPrincipalCache';

export interface ResolvedPrincipalCacheDoc {
  appUserId: string;
  tenantId: string;
  engine: string;
  /** Lowercased Google user or group email — the cache key's identity component. */
  googleEmail: string;
  hasLicense?: boolean;
  /** True once roles/discoveryengine.agentspaceUser is confirmed granted on this engine. */
  hasEngineRole?: boolean;
  updatedAt: Date;
}

export async function getCachedPrincipalState(
  appUserId: string,
  tenantId: string,
  engine: string,
  googleEmail: string,
): Promise<{ hasLicense?: boolean; hasEngineRole?: boolean } | undefined> {
  if (!isDbConnected()) return undefined;
  try {
    const doc = await getDb(config.CSGE_DB)
      .collection<ResolvedPrincipalCacheDoc>(COLL)
      .findOne({ appUserId, tenantId, engine, googleEmail: googleEmail.toLowerCase() });
    if (!doc) return undefined;
    return { hasLicense: doc.hasLicense, hasEngineRole: doc.hasEngineRole };
  } catch (e) {
    logger.warn(`getCachedPrincipalState read failed: ${(e as Error).message}`);
    return undefined;
  }
}

/** Merge-updates whichever of hasLicense/hasEngineRole the caller actually checked this call. */
export async function putCachedPrincipalState(
  appUserId: string,
  tenantId: string,
  engine: string,
  googleEmail: string,
  state: { hasLicense?: boolean; hasEngineRole?: boolean },
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    const set: Partial<ResolvedPrincipalCacheDoc> = { updatedAt: new Date() };
    if (state.hasLicense !== undefined) set.hasLicense = state.hasLicense;
    if (state.hasEngineRole !== undefined) set.hasEngineRole = state.hasEngineRole;
    await getDb(config.CSGE_DB)
      .collection<ResolvedPrincipalCacheDoc>(COLL)
      .updateOne(
        { appUserId, tenantId, engine, googleEmail: googleEmail.toLowerCase() },
        { $set: set },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`putCachedPrincipalState write failed: ${(e as Error).message}`);
  }
}
