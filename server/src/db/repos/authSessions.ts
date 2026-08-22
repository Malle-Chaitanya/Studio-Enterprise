import { getDb, isDbConnected } from '../core.js';
import { config } from '../../config.js';
import { logger } from '../../logger.js';

/**
 * OAuth tokens, owned by an app user and keyed by the connected ACCOUNT.
 *
 * Before this, tokens lived only on `migrationSessions`. That made the credential a property
 * of a migration rather than of the connection: disconnecting or losing a session threw away
 * a refresh token the user had already consented to, and reconnecting the same cloud minted a
 * second session rather than recognising the account. The collection and its unique index
 * were scaffolded for this and then never written to — 0 rows — so the durable half of the
 * flow was missing entirely.
 *
 * Keyed `(appUserId, provider, accountId)` where accountId is the account's own email,
 * lowercased. That key IS the dedupe: connecting the same account twice updates one row
 * instead of accumulating copies, because "the same person's same mailbox" is one connection
 * no matter how many times consent is granted.
 *
 * Best-effort like every other repo here — a Mongo outage must not break sign-in, so writes
 * log and return rather than throwing. The migration session still carries the live tokens
 * for the current run, so a failed persist costs durability, not the connection.
 */

const COLL = 'authSessions';

export type AuthProvider = 'microsoft' | 'google';

export interface AuthSessionDoc {
  appUserId: string;
  provider: AuthProvider;
  /** The connected account's email, lowercased. Never a display name — it is a key. */
  accountId: string;
  email: string;
  displayName?: string;
  /** Microsoft only: the tenant the account belongs to. */
  tenantId?: string;
  refreshToken?: string;
  /** When the access token dies. The refresh token is what actually matters. */
  expiresAt?: Date;
  connectedAt: Date;
  updatedAt: Date;
}

/**
 * Record a connected account, or update it if this user already connected it.
 *
 * Deliberately NEVER logs the token. The rule in this codebase is to log the fact of an auth
 * event and the identity, never the bearer value.
 */
export async function upsertAuthSession(
  s: Omit<AuthSessionDoc, 'connectedAt' | 'updatedAt' | 'accountId'> & { accountId?: string },
): Promise<void> {
  if (!isDbConnected()) return;
  const accountId = (s.accountId ?? s.email ?? '').toLowerCase();
  if (!s.appUserId || !accountId) {
    // Without an owner or an account key this row could not be found again, and an
    // unfindable credential is worse than none: it persists a secret nothing can revoke.
    logger.warn(
      { provider: s.provider, hasOwner: !!s.appUserId },
      'authSessions: refusing to persist a connection with no owner or no account id',
    );
    return;
  }
  try {
    const now = new Date();
    await getDb(config.CSGE_DB)
      .collection<AuthSessionDoc>(COLL)
      .updateOne(
        { appUserId: s.appUserId, provider: s.provider, accountId },
        {
          $set: {
            email: s.email.toLowerCase(),
            displayName: s.displayName,
            tenantId: s.tenantId,
            refreshToken: s.refreshToken,
            expiresAt: s.expiresAt,
            updatedAt: now,
          },
          $setOnInsert: { appUserId: s.appUserId, provider: s.provider, accountId, connectedAt: now },
        },
        { upsert: true },
      );
    logger.info(`connected ${s.provider} account ${s.email} for app user ${s.appUserId}`);
  } catch (e) {
    logger.warn(`authSessions upsert failed: ${(e as Error).message}`);
  }
}

/** Every account this user has connected for a provider, newest first. */
export async function listAuthSessions(
  appUserId: string,
  provider?: AuthProvider,
): Promise<AuthSessionDoc[]> {
  if (!isDbConnected() || !appUserId) return [];
  try {
    return (await getDb(config.CSGE_DB)
      .collection<AuthSessionDoc>(COLL)
      .find({ appUserId, ...(provider ? { provider } : {}) })
      .sort({ updatedAt: -1 })
      .toArray()) as AuthSessionDoc[];
  } catch (e) {
    logger.warn(`authSessions list failed: ${(e as Error).message}`);
    return [];
  }
}

/**
 * The most recently used account for this user + provider.
 *
 * This is the "restore on boot" half of the flow, done as a read rather than as an in-memory
 * map rebuilt at startup: there is no process state to lose, so a redeploy mid-login cannot
 * strand anyone. See the note on `putState` in routes/auth.ts — the same reasoning that made
 * the OAuth state stateless applies here.
 */
export async function getAuthSession(
  appUserId: string,
  provider: AuthProvider,
): Promise<AuthSessionDoc | null> {
  const rows = await listAuthSessions(appUserId, provider);
  return rows[0] ?? null;
}

/** Forget one connected account. Scoped by owner — never delete by accountId alone. */
export async function deleteAuthSession(
  appUserId: string,
  provider: AuthProvider,
  accountId: string,
): Promise<void> {
  if (!isDbConnected() || !appUserId) return;
  try {
    await getDb(config.CSGE_DB)
      .collection<AuthSessionDoc>(COLL)
      .deleteOne({ appUserId, provider, accountId: accountId.toLowerCase() });
    logger.info(`disconnected ${provider} account ${accountId} for app user ${appUserId}`);
  } catch (e) {
    logger.warn(`authSessions delete failed: ${(e as Error).message}`);
  }
}
