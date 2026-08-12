/**
 * Sign-in for the tool itself: POST /api/login, POST /api/logout, GET /api/me.
 *
 * Mounted at the root (not under /api/auth) because /api/auth is the CUSTOMER cloud
 * handshake — Microsoft and Google OAuth — and conflating "who is using CloudFuze" with
 * "which customer clouds are connected" is how the two got confused in the first place.
 */
import { Router } from 'express';
import {
  clearAuthCookie,
  createLoginSession,
  destroyLoginSession,
  setAuthCookie,
  authTokenFrom,
} from '../auth/appAuth.js';
import { verifyLogin } from '../db/repos/users.js';
import { isDbConnected } from '../db/core.js';
import { logger } from '../logger.js';

export const loginRouter = Router();

loginRouter.post('/api/login', async (req, res) => {
  const { email, password } = req.body as { email?: string; password?: string };
  if (!email || !password) {
    return void res.status(400).json({ error: 'email_and_password_required' });
  }
  // Sign-in cannot be answered from the in-memory fallback: the accounts live in Mongo.
  // Returning 401 here would tell the operator "wrong password" when the truth is "the
  // database is down" — and 401 is the one status the client treats as final.
  if (!isDbConnected()) {
    return void res.status(503).json({
      error: 'auth_unavailable',
      detail: 'The account database is unreachable, so sign-in cannot be verified right now.',
    });
  }

  const user = await verifyLogin(email.trim().toLowerCase(), password);
  if (!user) {
    // Deliberately identical for unknown-email and wrong-password: distinguishing them
    // turns this endpoint into a way to enumerate who has an account.
    logger.warn(`failed sign-in attempt for ${email.trim().toLowerCase()}`);
    return void res.status(401).json({ error: 'invalid_credentials' });
  }

  const token = await createLoginSession({
    appUserId: String(user._id),
    email: user.email,
    role: user.role,
  });
  setAuthCookie(res, token);
  logger.info(`sign-in: ${user.email}`);
  // The appUserId is deliberately NOT returned. The client never needs it, and anything
  // the client holds is something it can later assert.
  res.json({ email: user.email, name: user.name, role: user.role });
});

loginRouter.post('/api/logout', async (req, res) => {
  const token = authTokenFrom(req);
  if (token) await destroyLoginSession(token);
  clearAuthCookie(res);
  res.json({ ok: true });
});

/** Who am I? Used by the SPA to decide between the app and the login screen on load. */
loginRouter.get('/api/me', async (req, res) => {
  if (!req.appUser) return void res.status(401).json({ error: 'not_signed_in' });
  res.json({ email: req.appUser.email, role: req.appUser.role });
});
