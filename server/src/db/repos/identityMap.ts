import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { IdentityMapOverrides } from '../../types.js';

/**
 * Durable per-customer identity override map (collection: identityMappings).
 * Keyed by appUserId + tenantId — reused across runs; session TTL is wrong here.
 */

const COLL = 'identityMappings';

export interface IdentityMapDoc {
  appUserId: string;
  tenantId: string;
  users: Record<string, string>;
  groups: Record<string, string>;
  updatedAt: Date;
  createdAt?: Date;
}

export async function getIdentityMap(
  appUserId: string,
  tenantId: string,
): Promise<IdentityMapOverrides> {
  if (!isDbConnected()) return { users: {}, groups: {} };
  try {
    const doc = await getDb(config.CSGE_DB)
      .collection<IdentityMapDoc>(COLL)
      .findOne({ appUserId, tenantId });
    return {
      users: doc?.users ?? {},
      groups: doc?.groups ?? {},
    };
  } catch (e) {
    logger.warn(`getIdentityMap read failed: ${(e as Error).message}`);
    return { users: {}, groups: {} };
  }
}

/** Upsert the full override maps for this tenant (replaces users/groups wholesale). */
export async function putIdentityMap(
  appUserId: string,
  tenantId: string,
  overrides: IdentityMapOverrides,
): Promise<IdentityMapOverrides> {
  const users: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides.users ?? {})) {
    const sk = k.trim().toLowerCase();
    const gv = v.trim().toLowerCase();
    if (sk && gv) users[sk] = gv;
  }
  const groups: Record<string, string> = {};
  for (const [k, v] of Object.entries(overrides.groups ?? {})) {
    const sk = k.trim();
    const gv = v.trim().toLowerCase();
    if (sk && gv) groups[sk] = gv;
  }
  if (!isDbConnected()) return { users, groups };
  try {
    const now = new Date();
    await getDb(config.CSGE_DB)
      .collection<IdentityMapDoc>(COLL)
      .updateOne(
        { appUserId, tenantId },
        {
          $set: { users, groups, updatedAt: now },
          $setOnInsert: { appUserId, tenantId, createdAt: now },
        },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`putIdentityMap persist failed: ${(e as Error).message}`);
  }
  return { users, groups };
}
