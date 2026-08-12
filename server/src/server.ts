import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { serviceAccountConfigured } from './auth/google.js';
import { connectMongo } from './db/mongo.js';
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

app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
app.use(express.json({ limit: '2mb' }));
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
  // Connect to Mongo first so sessions/results persist. Non-fatal: the app
  // still boots (with in-memory session fallback) if the DB is unreachable.
  try {
    await connectMongo();
    // Any run still marked `running` predates this process, so it died with whatever was
    // running it. Closing them here is the only thing that stops "running" meaning
    // "running, or crashed three days ago and nobody noticed".
    const interrupted = await reconcileInterruptedRuns();
    if (interrupted > 0) {
      logger.warn(`${interrupted} migration run(s) were interrupted by a restart — marked interrupted; staged agents kept for a re-run.`);
    }
  } catch (err) {
    logger.warn(`MongoDB unavailable — running without persistence: ${(err as Error).message}`);
  }

  app.listen(config.PORT, () => {
    logger.info(`CloudFuze Studio Migrate API on http://localhost:${config.PORT}`);
    logger.info(`Web origin: ${config.WEB_ORIGIN}`);
    if (!serviceAccountConfigured()) {
      logger.warn('No Google service account configured — Gemini operations will fail.');
    }
  });

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
