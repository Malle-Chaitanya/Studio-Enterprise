/**
 * Application sign-in: who is using this tool.
 *
 * Distinct from `auth/microsoft.ts` and `auth/google.ts`, which authenticate the tool to a
 * CUSTOMER'S clouds. This file answers the earlier question — which of our own users is
 * making the request — and it is what makes `appUserId` a fact instead of a default.
 *
 * Before this existed, every session in the product carried the literal string 'default'
 * and a session id was a bearer token: anyone holding one could read that migration's
 * data. The isolation the collections were designed for (every migration-scoped query
 * filters by `appUserId`) was real in the queries and empty in practice, because the value
 * being filtered on was the same for everyone.
 *
 * Design:
 *   - Sign-in mints an opaque 32-byte token stored server-side in `appLoginSessions` with
 *     a TTL. The cookie holds only the token; the browser never learns the appUserId, so
 *     it cannot assert one.
 *   - httpOnly, and secure-in-production. The token is not reachable from JS, which is what
 *     keeps an XSS in the SPA from becoming a stolen migration session.
 *   - SameSite is None in production, Lax in dev. None is what lets a frontend on a DIFFERENT
 *     origin (diycf.cloudfuze.com, localhost:3003) send the cookie at all -- under Lax the
 *     browser withholds it on every cross-site XHR and the API answers 401 with the operator
 *     seeing a correct CORS allowlist and a signed-in user. None REQUIRES Secure, so dev
 *     (plain http on localhost) stays Lax: a None cookie without Secure is dropped outright,
 *     which looks like a broken login rather than a policy choice.
 *
 *     Dropping Lax gives up the browser's built-in CSRF defence. What replaces it: every
 *     state-changing route takes a JSON body or a non-simple method, so the browser preflights
 *     it, and the CORS allowlist in server.ts refuses the preflight for any origin not on the
 *     list. Keep it that way -- a state-changing plain GET, or a route that accepts
 *     form-encoded input, would be reachable from any page on the internet.
 *   - No JWT. A revocable server-side row is what lets sign-out actually end a session;
 *     a self-contained token cannot be withdrawn before it expires.
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from '../config.js';
import { getDb, isDbConnected } from '../db/core.js';
import { logger } from '../logger.js';

const COLL = 'appLoginSessions';
const COOKIE = 'csge_auth';
/** Long enough that a migration run never expires mid-flight; short enough to matter. */
const TTL_DAYS = 7;

interface LoginSessionDoc {
  _id: string;
  appUserId: string;
  email: string;
  role: string;
  createdAt: Date;
  /** TTL index target. */
  expiresAt: Date;
}

/** In-memory fallback so the app still signs in with Mongo down (matches the session store). */
const fallback = new Map<string, LoginSessionDoc>();

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireAuth` / `attachUser`. Never read from the client. */
      appUser?: { appUserId: string; email: string; role: string };
    }
  }
}

export async function createLoginSession(user: {
  appUserId: string;
  email: string;
  role: string;
}): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const doc: LoginSessionDoc = {
    _id: token,
    appUserId: user.appUserId,
    email: user.email,
    role: user.role,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + TTL_DAYS * 86400_000),
  };
  if (isDbConnected()) {
    try {
      await getDb(config.CSGE_DB).collection<LoginSessionDoc>(COLL).insertOne(doc);
      return token;
    } catch (e) {
      logger.warn(`login session write failed, using memory: ${(e as Error).message}`);
    }
  }
  fallback.set(token, doc);
  return token;
}

async function readLoginSession(token: string): Promise<LoginSessionDoc | null> {
  if (isDbConnected()) {
    try {
      const doc = await getDb(config.CSGE_DB).collection<LoginSessionDoc>(COLL).findOne({ _id: token });
      // The TTL index reaps lazily (up to a minute late), so an expired row can still be
      // returned. Treating it as valid would extend every session by that window.
      if (doc && doc.expiresAt.getTime() > Date.now()) return doc;
      return null;
    } catch (e) {
      logger.warn(`login session read failed: ${(e as Error).message}`);
      return null;
    }
  }
  const doc = fallback.get(token);
  return doc && doc.expiresAt.getTime() > Date.now() ? doc : null;
}

export async function destroyLoginSession(token: string): Promise<void> {
  fallback.delete(token);
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection<LoginSessionDoc>(COLL).deleteOne({ _id: token });
  } catch (e) {
    logger.warn(`login session delete failed: ${(e as Error).message}`);
  }
}

/**
 * Parse one cookie by name.
 *
 * Hand-rolled rather than adding `cookie-parser`: we read exactly one cookie and a
 * dependency that touches every request is not worth 6 lines.
 */
function cookieValue(req: Request, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

/**
 * The attributes the auth cookie is set with.
 *
 * Shared by set and clear on purpose: a browser only removes a cookie when the clearing
 * Set-Cookie carries the SAME sameSite/secure/path, so defining these twice would mean
 * sign-out silently leaving the cookie in place on cross-site frontends.
 */
function cookieOptions() {
  // The dev server is plain http on localhost; forcing `secure` there would silently drop
  // the cookie and look like a broken login. SameSite=None is only legal WITH Secure, so
  // the two move together.
  const crossSite = process.env.NODE_ENV === 'production';
  return {
    httpOnly: true,
    sameSite: crossSite ? ('none' as const) : ('lax' as const),
    secure: crossSite,
    path: '/',
  };
}

export function setAuthCookie(res: Response, token: string): void {
  res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: TTL_DAYS * 86400_000 });
}

export function clearAuthCookie(res: Response): void {
  res.clearCookie(COOKIE, cookieOptions());
}

export function authTokenFrom(req: Request): string | undefined {
  return cookieValue(req, COOKIE);
}

/** Attach the user when signed in; never rejects. For routes that are open by design. */
export async function attachUser(req: Request, _res: Response, next: NextFunction): Promise<void> {
  const token = authTokenFrom(req);
  if (token) {
    const doc = await readLoginSession(token);
    if (doc) req.appUser = { appUserId: doc.appUserId, email: doc.email, role: doc.role };
  }
  next();
}

/**
 * Reject anything without a valid sign-in.
 *
 * Mounted on the migration-scoped routers only. `/api/health` and the OAuth callbacks stay
 * open on purpose: the callbacks are hit by a redirect from Microsoft/Google, and a 401
 * there would break the connect handshake rather than protect anything — they carry a
 * one-time state parameter of their own.
 */
export async function requireAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = authTokenFrom(req);
  if (!token) return void res.status(401).json({ error: 'not_signed_in' });
  const doc = await readLoginSession(token);
  if (!doc) return void res.status(401).json({ error: 'session_expired' });
  req.appUser = { appUserId: doc.appUserId, email: doc.email, role: doc.role };
  next();
}

/**
 * Constant-time comparison for anything token-shaped.
 *
 * Not used on the bcrypt path (bcrypt.compare is already constant-time) — kept for
 * comparing opaque ids, where an early-exit `===` leaks length and prefix by timing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
