import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { serviceAccountConfigured } from './auth/google.js';
import { connectMongo } from './db/mongo.js';
import { isDbConnected } from './db/core.js';
import { reconcileInterruptedRuns } from './db/repos/migrations.js';
import { authRouter, legacyAuthRouter } from './routes/auth.js';
import { loginRouter } from './routes/login.js';
import { attachUser, requireAuth } from './auth/appAuth.js';
import { enforceSessionOwnership } from './auth/sessionOwnership.js';
import { destinationRouter } from './routes/destination.js';
import { exploreRouter } from './routes/explore.js';
import { agentRouter } from './routes/agent.js';
import { identityRouter } from './routes/identity.js';
import { migrateRouter } from './routes/migrate.js';
import { runPendingGroundingRechecks } from './services/groundingRecheck.js';

const app = express();

// Exact-match allowlist, never a wildcard and never a reflect-any. `credentials: true`
// is what makes the difference: the browser rejects `*` outright on a credentialed
// request, and reflecting whatever Origin arrives would let any page a signed-in admin
// visits call this API with their cookie attached.
//
// A request with no Origin header (curl, a server-to-server health check, a same-origin
// navigation) is allowed through: CORS is a browser mechanism, and refusing those would
// break the deploy's own smoke tests without stopping anything.
const WEB_ORIGINS = config.WEB_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);
app.use(
  cors({
    origin: (origin, cb) => cb(null, !origin || WEB_ORIGINS.includes(origin)),
    credentials: true,
  }),
);
app.use(express.json({ limit: '2mb' }));

/**
 * One line per request: method, path, status, duration.
 *
 * There was none until 2026-08-24, and its absence is not a missing nicety -- it is why a
 * production migration investigation had nothing to read. Container logs are wiped on every
 * deploy, and what survived recorded only what a handler chose to say, so "the app is doing
 * nothing" and "the app is doing plenty and mentioning none of it" looked identical.
 *
 * `req.path`, never `req.originalUrl`: the query string carries the session id on every GET,
 * and a log line is the one place a server-side-only identifier must not end up (see
 * security-rules.md -- session ids are opaque and server-side, and logs get pasted into
 * tickets). The path alone is enough to see the shape of a flow.
 *
 * Logged on 'finish' rather than up front so the status and duration are real rather than
 * predicted, and at warn for 4xx/5xx so a failing call is greppable without reading
 * everything around it. Best-effort by construction: it registers a listener and returns.
 */
app.use((req, res, next) => {
  const startedAt = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - startedAt;
    const line = `${req.method} ${req.path} ${res.statusCode} ${ms}ms`;
    if (res.statusCode >= 500) logger.error(line);
    else if (res.statusCode >= 400) logger.warn(line);
    else logger.info(line);
  });
  next();
});
// Resolve the signed-in user on every request. Attaching it globally (rather than only
// where it is required) means an open route can still record WHO acted, without any route
// having to trust a client-supplied identity.
app.use(attachUser);

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    tool: 'CloudFuze Studio Migrate',
    phase: 'agents',
    serviceAccount: serviceAccountConfigured(),
    // The process being up and the database being reachable are two different facts, and
    // conflating them is how a deploy went green while sign-in was refusing everyone:
    // appUsers lives in Mongo, so `db: false` means nobody can log in even though the
    // API answers. Reported separately so a smoke test can choose which one it gates on.
    db: isDbConnected(),
  });
});

// Sign-in for the tool itself. Open by necessity — it is how you get a session.
app.use(loginRouter);

// /api/auth is the CUSTOMER cloud handshake (Microsoft + Google OAuth). It stays open:
// the callbacks arrive as redirects from Microsoft and Google, and a 401 there would
// break the connect flow rather than protect anything. They carry their own one-time
// state parameter.
app.use('/api/auth', authRouter);

// Everything below touches customer migration data. Two gates, in order: prove you are a
// user, then prove the session you named is yours. Applied at the router so a route added
// later inherits both instead of having to remember them.
const scoped = [requireAuth, enforceSessionOwnership];
app.use('/api/explore', scoped, exploreRouter);
app.use('/api/destination', scoped, destinationRouter);
app.use('/api/identity', scoped, identityRouter);
app.use('/api/agent', scoped, agentRouter);
app.use('/api/migrate', scoped, migrateRouter);
// Legacy redirect-URI aliases (/callback/microsoft, /callback/google).
app.use('/', legacyAuthRouter);

async function start(): Promise<void> {
  // Listen FIRST, connect to Mongo alongside.
  //
  // This used to await connectMongo() before binding the port. Persistence is
  // best-effort everywhere else in this codebase — every repo write checks
  // isDbConnected() and returns quietly — but the boot did not honour that: with the
  // database unreachable the driver retried 5 times at ~13s apiece, so the process
  // served nothing for over a minute and then came up anyway. The deploy's health gate
  // polls for about that long, so a recoverable database blip failed the whole deploy,
  // and the log read "API never became healthy" about a server that was fine.
  //
  // Binding first also makes /api/health answer during the outage, which is what lets
  // it report `db: false` instead of the request simply hanging.
  app.listen(config.PORT, () => {
    logger.info(`CloudFuze Studio Migrate API on http://localhost:${config.PORT}`);
    logger.info(`Web origin(s): ${WEB_ORIGINS.join(', ')}`);
    if (!serviceAccountConfigured()) {
      logger.warn('No Google service account configured — Gemini operations will fail.');
    }
  });

  // Connect alongside, not before. Non-fatal by design: the app runs with an in-memory
  // session fallback if the database never arrives, and every repo write already guards
  // on isDbConnected().
  void (async () => {
    try {
      await connectMongo();
      // Any run still marked `running` predates this process, so it died with whatever
      // was running it. Closing them here is the only thing that stops "running" meaning
      // "running, or crashed three days ago and nobody noticed".
      const interrupted = await reconcileInterruptedRuns();
      if (interrupted > 0) {
        logger.warn(`${interrupted} migration run(s) were interrupted by a restart — marked interrupted; staged agents kept for a re-run.`);
      }
    } catch (err) {
      logger.warn(`MongoDB unavailable — running without persistence: ${(err as Error).message}`);
    }
  })();

  // Background self-repair: Discovery Engine indexing can take much longer
  // than any single migration request can block on (observed live: 6-10+
  // min past import). This sweep picks up where an ADK file-grounding
  // attempt timed out and auto-repoints the deployed agent once indexing
  // actually completes — see services/groundingRecheck.ts. Best-effort and
  // never throws; a Mongo outage just means nothing is due this tick.
  if (serviceAccountConfigured()) {
    setInterval(() => {
      runPendingGroundingRechecks().catch((e) => logger.warn(`grounding recheck sweep failed: ${(e as Error).message}`));
    }, 5 * 60_000);
  }
}

void start();
