import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { IdentityMapOverrides } from '../../types.js';

/**
 * Durable per-customer identity override map (collection: identityMappings).
 * Keyed by appUserId + tenantId + geminiProject — reused across runs; session
 * TTL is wrong here.
 *
 * geminiProject is part of the key because the SAME source tenant can be
 * migrated to more than one destination over time (a pilot into one Workspace,
 * then a real cutover into another; or two genuinely separate customers who
 * happen to share a migration operator). A mapping like erik@filefuze.co ->
 * admin@migrationn.com is only true FOR that destination — reusing it for a
 * later migration of the same tenant into a different Google org would hand
 * one person's access to whichever account happened to be typed in last time,
 * silently. Scoped the same way services/gemini.ts already scopes the
 * adjacent resolvedPrincipalCache (by dest.engine) — this just uses the
 * project number, which is already on Session and needs no extra network
 * call to read.
 */

const COLL = 'identityMappings';

export interface IdentityMapDoc {
  appUserId: string;
  tenantId: string;
  /** Destination GCP project — '' when no Google destination is connected yet. */
  geminiProject: string;
  users: Record<string, string>;
  groups: Record<string, string>;
  updatedAt: Date;
  createdAt?: Date;
}

export async function getIdentityMap(
  appUserId: string,
  tenantId: string,
  geminiProject: string,
): Promise<IdentityMapOverrides> {
  if (!isDbConnected()) return { users: {}, groups: {} };
  try {
    const doc = await getDb(config.CSGE_DB)
      .collection<IdentityMapDoc>(COLL)
      .findOne({ appUserId, tenantId, geminiProject });
    return {
      users: doc?.users ?? {},
      groups: doc?.groups ?? {},
    };
  } catch (e) {
    logger.warn(`getIdentityMap read failed: ${(e as Error).message}`);
    return { users: {}, groups: {} };
  }
}

/** Upsert the full override maps for this tenant+destination (replaces users/groups wholesale). */
export async function putIdentityMap(
  appUserId: string,
  tenantId: string,
  geminiProject: string,
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
        { appUserId, tenantId, geminiProject },
        {
          $set: { users, groups, updatedAt: now },
          $setOnInsert: { appUserId, tenantId, geminiProject, createdAt: now },
        },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`putIdentityMap persist failed: ${(e as Error).message}`);
  }
  return { users, groups };
}
