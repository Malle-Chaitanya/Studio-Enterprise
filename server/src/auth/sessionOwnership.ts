/**
 * A migration session belongs to the user who created it.
 *
 * Every migration route takes a `session` id from the client (query param on GETs, body
 * field on POSTs). Without this check that id IS the credential: anyone who learns one —
 * from a shared URL, a screenshot, a log — can read that customer's environments, their
 * staged agents and their connector configuration. `requireAuth` proves you are *a* user;
 * this proves you are *that* user.
 *
 * Enforced as middleware on the routers rather than inside `getSession`, so a route added
 * next year is covered by default instead of by remembering. The trade is that it can only
 * see ids in the two places the client is allowed to put them, which is why the convention
 * in api-conventions.md matters.
 */
import type { NextFunction, Request, Response } from 'express';
import { DEFAULT_APP_USER_ID, getSession } from '../sessionStore.js';
import { logger } from '../logger.js';

/** Where the client is allowed to pass a session id. Matches api-conventions.md. */
function sessionIdFrom(req: Request): string | undefined {
  const fromQuery = req.query?.session;
  if (typeof fromQuery === 'string' && fromQuery) return fromQuery;
  const body = req.body as { session?: unknown } | undefined;
  if (body && typeof body.session === 'string' && body.session) return body.session;
  return undefined;
}

export async function enforceSessionOwnership(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const id = sessionIdFrom(req);
  // No session id on this request — nothing to authorize here. Routes that need one
  // return their own `session_not_found`, and duplicating that here would change
  // established error codes the web client switches on.
  if (!id) return next();

  const session = await getSession(id);
  if (!session) return next();

  const owner = session.appUserId;
  const caller = req.appUser?.appUserId;

  // Sessions created before sign-in existed all carry the literal 'default'. Locking them
  // out would strand every already-connected customer behind a migration they cannot run,
  // so they stay reachable by any signed-in user until `_rekey_app_user.ts` gives them a
  // real owner. This is a KNOWN residual hole, not an oversight: it is why the startup
  // check counts the remaining rows out loud.
  if (!owner || owner === DEFAULT_APP_USER_ID) return next();

  if (owner !== caller) {
    logger.warn(`session ownership refused: ${req.method} ${req.path} (session owned by another user)`);
    return void res.status(403).json({ error: 'session_not_yours' });
  }
  next();
}
