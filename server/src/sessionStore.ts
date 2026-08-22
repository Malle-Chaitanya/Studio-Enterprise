import { randomBytes } from 'node:crypto';
import type { ResolvedPlan, AwaitingHuman } from './types.js';
import { getDb, isDbConnected } from './db/core.js';
import { logger } from './logger.js';

/**
 * DB-backed session store (collection: migrationSessions). Sessions now survive
 * restarts and are shared across instances. A connected session has no expiry —
 * it represents a live cloud connection and is meant to persist until the user
 * explicitly disconnects (see /api/auth/disconnect), not time out on its own.
 *
 * The public API is now async (createSession/getSession/updateSession return
 * Promises) — callers await them. When the DB is unreachable we fall back to an
 * in-memory Map so dev/demo still works without Mongo, matching GEM_CO's
 * "run without persistence" behavior.
 */
export interface Session {
  /** This session's own opaque id, so a holder can write back to it. */
  id?: string;
  /** Free-form progress marker. 'google_only' means the Microsoft/source side
   *  was disconnected while a Google connection survived on this same doc —
   *  see POST /api/auth/disconnect and msCallback's reconnect-reattach logic. */
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
  /** Google OAuth refresh token — lets the server mint a fresh gToken once the
   *  ~1hr access token dies, instead of degrading to "just the one already-
   *  connected project" (see destination.ts /projects). Present only for
   *  sessions connected after 2026-08-07; older sessions have none and need a
   *  one-time reconnect to pick one up. */
  gRefreshToken?: string;
  geminiProject?: string;
  saOk?: boolean;
  /** Why saOk is false (e.g. "add our SA to Domain-Wide Delegation") — shown to the client. */
  saReason?: string;
  // resolved migration plan (set by POST /api/migrate/plan)
  plan?: ResolvedPlan;
  /**
   * Set when a run for the CURRENT `plan` finished, and cleared whenever POST /plan
   * writes a new one.
   *
   * Without it, a plan stayed executable forever: EventSource reconnects on its own after
   * the server closes the response at the end of a run, and that reconnect would start the
   * whole migration again off the plan still sitting here. The runRegistry guard only
   * covers a run that is still LIVE, so this covers the window after it ends — together
   * they mean idempotency no longer depends on the browser choosing not to reconnect.
   */
  planConsumedAt?: number;
  /** Summary of the run that consumed the plan, so a reconnect can be told the ending. */
  planConsumedSummary?: string;
  /**
   * A stop that needs a person, surviving a browser refresh.
   *
   * The SSE event alone is not enough: it exists only in the stream, so reloading the page
   * loses the fact that it is the operator's turn and the run looks merely idle. Cleared
   * when the run moves on.
   */
  awaitingHuman?: AwaitingHuman;
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

/**
 * The isolation key for anything a customer OWNS — Secret Manager ids above all.
 *
 * `appUserId` is the intended key, but no route sets it: sign-in was never wired, so every
 * session in the product today carries the literal string 'default'. Measured 2026-08-12 —
 * every row in `migrationSessions`, `connectorCredentials`, `adkDeployments` and
 * `stagedAgents` is `appUserId: 'default'`. On a single-customer install that is harmless.
 * On one deployment serving several customers it means one shared credential namespace:
 * customer B's Atlassian token overwrites customer A's, and A's deployed agent then calls
 * Atlassian with B's credential.
 *
 * Until login exists, the Microsoft tenant id is a real discriminator and is already on the
 * session — it comes from the OAuth flow, not from anything the client can assert. Using it
 * gives genuine per-customer isolation now, and `appUserId` takes precedence the moment
 * sign-in lands, so nothing has to be undone.
 *
 * Not a substitute for authentication: it separates customers who connect different
 * Microsoft tenants. Two users inside ONE tenant still share a namespace, which is correct
 * for this product (they are the same customer) but must not be mistaken for user-level
 * isolation.
 */
export function credentialScope(session: Pick<Session, 'appUserId' | 'tenantId'>): string {
  if (session.appUserId && session.appUserId !== DEFAULT_APP_USER_ID) return session.appUserId;
  if (session.tenantId) return `ms-${session.tenantId}`;
  return DEFAULT_APP_USER_ID;
}

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
  void createdAtDate;
  // Carry the id onto the object. Without it a Session cannot be written back to, so any
  // code holding one (the orchestrator, notably) has to have the id passed alongside it and
  // the two can drift apart. The id is opaque and already server-side only.
  return { ...rest, id: _id };
}

/**
 * Latest session for an app user with at least one platform still connected
 * (Microsoft's dvToken OR Google's gEmail) — either alone counts, since
 * disconnecting one platform (see /api/auth/disconnect) can leave a
 * `google_only` doc with no dvToken. Lets login/hard-refresh "resume" whatever
 * is actually still connected instead of losing track of a surviving side.
 */
export async function findLatestConnectedSession(appUserId: string): Promise<string | null> {
  if (isDbConnected()) {
    try {
      const doc = await getDb()
        .collection<SessionDoc>(COLL)
        .find({
          appUserId,
          $or: [{ dvToken: { $exists: true, $ne: '' } }, { gEmail: { $exists: true, $ne: '' } }],
        })
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
    if (s.appUserId === appUserId && (s.dvToken || s.gEmail) && s.createdAt > latestAt) {
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
      return toSession(doc);
    } catch (e) {
      logger.warn(`getSession DB read failed, using memory: ${(e as Error).message}`);
    }
  }
  return fallback.get(id);
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

/**
 * Clear the same platform fields on every OTHER session doc for this app user that
 * carries the same real identity (tenantId for Microsoft, gEmail for Google).
 *
 * Each fresh "Connect Microsoft/Google" popup mints a new session doc rather than
 * reusing one, and connected sessions never expire — so a tenant/account that's been
 * connected and reconnected several times across testing ends up duplicated across
 * many docs. Without this, /api/auth/disconnect only cleared the ONE doc the user
 * was looking at; findLatestConnectedSession (used by the Login screen's "resume
 * most recent connected session") would then silently reattach to one of the other
 * still-connected duplicates, making an explicit disconnect look like it didn't
 * stick on the very next refresh/login.
 */
export async function unsetFieldsOnMatchingSessions(
  appUserId: string,
  match: Partial<Pick<Session, 'tenantId' | 'gEmail'>>,
  fields: (keyof Session)[],
): Promise<void> {
  const filter: Record<string, unknown> = { appUserId, ...match };
  const unset: Record<string, ''> = Object.fromEntries(fields.map((f) => [f as string, '']));
  if (isDbConnected()) {
    try {
      await getDb().collection<SessionDoc>(COLL).updateMany(filter, { $unset: unset });
      return;
    } catch (e) {
      logger.warn(`unsetFieldsOnMatchingSessions DB write failed: ${(e as Error).message}`);
    }
  }
  for (const [id, s] of fallback) {
    if (s.appUserId !== appUserId) continue;
    if (match.tenantId !== undefined && s.tenantId !== match.tenantId) continue;
    if (match.gEmail !== undefined && s.gEmail !== match.gEmail) continue;
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
