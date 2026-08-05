import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { serviceAccountConfigured } from './auth/google.js';
import { connectMongo } from './db/mongo.js';
import { authRouter, legacyAuthRouter } from './routes/auth.js';
import { destinationRouter } from './routes/destination.js';
import { exploreRouter } from './routes/explore.js';
import { agentRouter } from './routes/agent.js';
import { identityRouter } from './routes/identity.js';
import { migrateRouter } from './routes/migrate.js';

const app = express();

app.use(cors({ origin: config.WEB_ORIGIN, credentials: true }));
app.use(express.json({ limit: '2mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    tool: 'CloudFuze Studio Migrate',
    phase: 'agents',
    serviceAccount: serviceAccountConfigured(),
  });
});

app.use('/api/auth', authRouter);
app.use('/api/explore', exploreRouter);
app.use('/api/destination', destinationRouter);
app.use('/api/identity', identityRouter);
app.use('/api/agent', agentRouter);
app.use('/api/migrate', migrateRouter);
// Legacy redirect-URI aliases (/callback/microsoft, /callback/google).
app.use('/', legacyAuthRouter);

async function start(): Promise<void> {
  // Connect to Mongo first so sessions/results persist. Non-fatal: the app
  // still boots (with in-memory session fallback) if the DB is unreachable.
  try {
    await connectMongo();
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
}

void start();
