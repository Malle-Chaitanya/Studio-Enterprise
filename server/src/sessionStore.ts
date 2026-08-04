import { randomBytes } from 'node:crypto';
import type { ResolvedPlan } from './types.js';
import { getDb, isDbConnected } from './db/core.js';
import { logger } from './logger.js';

/**
 * DB-backed session store (collection: migrationSessions). Sessions now survive
 * restarts and are shared across instances. Expiry is handled by a Mongo TTL
 * index on `createdAt` (see db/mongo.ts) rather than an in-process sweep.
 *
 * The public API is now async (createSession/getSession/updateSession return
 * Promises) — callers await them. When the DB is unreachable we fall back to an
 * in-memory Map so dev/demo still works without Mongo, matching GEM_CO's
 * "run without persistence" behavior.
 */
export interface Session {
  step: string;
  createdAt: number;
  /** Owning app user (multi-tenant scope). Defaults until login is wired. */
  appUserId?: string;
  // Microsoft side
  tenantId?: string;
  orgName?: string;
  msEmail?: string;
  refreshToken?: string;
  dvToken?: string;
  dvDelegatedToken?: string;
  dvOrgUrl?: string;
  environments?: { name: string; url: string; id: string }[];
  botCount?: number;
  topicCount?: number;
  flowCount?: number;
  ksCount?: number;
  // Google side
  gEmail?: string;
  /** Google OAuth access token — identifies the client admin + discovers their
   *  Gemini project. Privileged Gemini writes use CloudFuze's service account,
   *  which the client grants access to (IAM on their project, or DWD). */
  gToken?: string;
  geminiProject?: string;
  saOk?: boolean;
  /** Why saOk is false (e.g. "add our SA to Domain-Wide Delegation") — shown to the client. */
  saReason?: string;
  // resolved migration plan (set by POST /api/migrate/plan)
  plan?: ResolvedPlan;
  // customer answers to workflow gap questions: env → flowId → gapId → answer
  workflowAnswers?: Record<string, Record<string, Record<string, string>>>;
  // linkage during OAuth handshakes
  msSessionId?: string;
  // NOTE: SharePoint/OneDrive connector setup state moved to the
  // knowledgeConnectors Mongo collection (db/repos/knowledgeConnectors.ts) —
  // per (appUserId, kind, siteUrl), not a session-wide singleton, since a
  // migration can touch several distinct SharePoint sites. See
  // .claude/memory/decisions.md (2026-08-03).
}

/** Used until real login is wired; every session/run is scoped to this. */
export const DEFAULT_APP_USER_ID = 'default';

const TTL_MS = 60 * 60 * 1000; // must match SESSION_TTL_SECONDS in db/mongo.ts
const COLL = 'migrationSessions';

// In-memory fallback (only used when Mongo is unreachable).
const fallback = new Map<string, Session>();

export function newId(bytes = 20): string {
  return randomBytes(bytes).toString('base64url');
}

interface SessionDoc extends Session {
  _id: string;
  createdAt: number;
  createdAtDate: Date; // TTL index target
}

function toSession(doc: SessionDoc | null): Session | undefined {
  if (!doc) return undefined;
  const { _id, createdAtDate, ...rest } = doc;
  void _id;
  void createdAtDate;
  return rest;
}

/**
 * Latest still-valid session for an app user that already has a source (Microsoft)
 * connection. Lets login "resume" prior cloud connections instead of losing them.
 */
export async function findLatestConnectedSession(appUserId: string): Promise<string | null> {
  const cutoff = Date.now() - TTL_MS;
  if (isDbConnected()) {
    try {
      const doc = await getDb()
        .collection<SessionDoc>(COLL)
        .find({ appUserId, dvToken: { $exists: true, $ne: '' }, createdAt: { $gt: cutoff } })
        .sort({ createdAt: -1 })
        .limit(1)
        .next();
      return doc?._id ?? null;
    } catch (e) {
      logger.warn(`findLatestConnectedSession failed: ${(e as Error).message}`);
    }
  }
  let latestId: string | null = null;
  let latestAt = 0;
  for (const [id, s] of fallback) {
    if (s.appUserId === appUserId && s.dvToken && s.createdAt > latestAt && s.createdAt > cutoff) {
      latestId = id;
      latestAt = s.createdAt;
    }
  }
  return latestId;
}

export async function createSession(init: Partial<Session> & { step: string }): Promise<string> {
  const id = newId();
  const now = Date.now();
  const session: Session = {
    createdAt: now,
    appUserId: init.appUserId ?? DEFAULT_APP_USER_ID,
    ...init,
  };
  if (isDbConnected()) {
    try {
      await getDb().collection<SessionDoc>(COLL).insertOne({
        _id: id,
        ...session,
        createdAtDate: new Date(now),
      });
      return id;
    } catch (e) {
      logger.warn(`createSession DB write failed, using memory: ${(e as Error).message}`);
    }
  }
  fallback.set(id, session);
  return id;
}

export async function getSession(id: string | undefined): Promise<Session | undefined> {
  if (!id) return undefined;
  if (isDbConnected()) {
    try {
      const doc = await getDb().collection<SessionDoc>(COLL).findOne({ _id: id });
      const s = toSession(doc);
      if (!s) return undefined;
      // Defensive TTL check in case the background TTL monitor hasn't swept yet.
      if (Date.now() - s.createdAt > TTL_MS) {
        await getDb().collection<SessionDoc>(COLL).deleteOne({ _id: id }).catch(() => {});
        return undefined;
      }
      return s;
    } catch (e) {
      logger.warn(`getSession DB read failed, using memory: ${(e as Error).message}`);
    }
  }
  const s = fallback.get(id);
  if (!s) return undefined;
  if (Date.now() - s.createdAt > TTL_MS) {
    fallback.delete(id);
    return undefined;
  }
  return s;
}

export async function updateSession(id: string, patch: Partial<Session>): Promise<void> {
  if (isDbConnected()) {
    try {
      await getDb().collection<SessionDoc>(COLL).updateOne({ _id: id }, { $set: patch });
      return;
    } catch (e) {
      logger.warn(`updateSession DB write failed, using memory: ${(e as Error).message}`);
    }
  }
  const s = fallback.get(id);
  if (s) fallback.set(id, { ...s, ...patch });
}

/** Unset specific fields on a session (used when disconnecting a platform). */
export async function unsetSessionFields(id: string, fields: (keyof Session)[]): Promise<void> {
  const unset: Record<string, ''> = Object.fromEntries(fields.map((f) => [f as string, '']));
  if (isDbConnected()) {
    try {
      await getDb().collection<SessionDoc>(COLL).updateOne({ _id: id }, { $unset: unset });
      return;
    } catch (e) {
      logger.warn(`unsetSessionFields DB write failed, using memory: ${(e as Error).message}`);
    }
  }
  const s = fallback.get(id);
  if (s) {
    for (const f of fields) delete s[f];
    fallback.set(id, s);
  }
}

/** Delete a session entirely (used when disconnecting the source platform). */
export async function deleteSession(id: string): Promise<void> {
  if (isDbConnected()) {
    try {
      await getDb().collection<SessionDoc>(COLL).deleteOne({ _id: id });
    } catch (e) {
      logger.warn(`deleteSession DB delete failed: ${(e as Error).message}`);
    }
  }
  fallback.delete(id);
}
