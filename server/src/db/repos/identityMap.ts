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

/**
 * Merge a partial save onto what is already stored.
 *
 * A caller that knows about only some of the mappings must not be able to delete the rest -
 * that is the whole point of merge mode. Deletion therefore has to be SAID, not implied by
 * absence: a key sent with an empty value is removed. `sanitized` is the cleaned subset
 * (empty values already dropped), `raw` is what actually arrived, which is where the
 * deliberate blanks still survive to be read.
 */
export function mergeOverrideMap(
  current: Record<string, string>,
  sanitized: Record<string, string>,
  raw: Record<string, string>,
  normalizeKey: (k: string) => string,
): Record<string, string> {
  const next = { ...current, ...sanitized };
  for (const [k, v] of Object.entries(raw)) {
    if (!String(v ?? '').trim()) delete next[normalizeKey(k)];
  }
  return next;
}


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

/**
 * Upsert the override maps for this tenant+destination.
 *
 * WHY THE MODE. This used to replace `users` wholesale, which is right for a PUT but wrong for
 * how the screens actually call it: the v2 Map-users page saves only the subset it is holding
 * (the freshly auto-matched pairs, or the pending draft), so a partial save silently DESTROYED
 * every mapping not on screen. The loss surfaced three steps later as a migration reporting
 * zero identity overrides, and the per-caller connector work then had no map to resolve a
 * caller through and fail-closed on every request. Merge is the safe default; 'replace' stays
 * available for the deliberate clear-all.
 *
 * In merge mode an EMPTY STRING value means "unmap this source" - the sanitizer below drops
 * empty values, so without this a cleared dropdown could not be expressed at all.
 */
export async function putIdentityMap(
  appUserId: string,
  tenantId: string,
  geminiProject: string,
  overrides: IdentityMapOverrides,
  mode: 'replace' | 'merge' = 'replace',
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
  let nextUsers = users;
  let nextGroups = groups;
  if (mode === 'merge') {
    const current = await getIdentityMap(appUserId, tenantId, geminiProject);
    nextUsers = mergeOverrideMap(current.users, users, overrides.users ?? {}, (k) =>
      k.trim().toLowerCase(),
    );
    nextGroups = mergeOverrideMap(current.groups, groups, overrides.groups ?? {}, (k) => k.trim());
  }

  if (!isDbConnected()) return { users: nextUsers, groups: nextGroups };
  try {
    const now = new Date();
    await getDb(config.CSGE_DB)
      .collection<IdentityMapDoc>(COLL)
      .updateOne(
        { appUserId, tenantId, geminiProject },
        {
          $set: { users: nextUsers, groups: nextGroups, updatedAt: now },
          $setOnInsert: { appUserId, tenantId, geminiProject, createdAt: now },
        },
        { upsert: true },
      );
  } catch (e) {
    logger.warn(`putIdentityMap persist failed: ${(e as Error).message}`);
  }
  return { users: nextUsers, groups: nextGroups };
}
