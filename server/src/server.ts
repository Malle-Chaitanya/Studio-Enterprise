import cors from 'cors';
import express from 'express';
import { config } from './config.js';
import { logger } from './logger.js';
import { serviceAccountConfigured } from './auth/google.js';
import { connectMongo } from './db/mongo.js';
import { authRouter, legacyAuthRouter } from './routes/auth.js';
import { destinationRouter } from './routes/destination.js';
import { exploreRouter } from './routes/explore.js';
import { migrateRouter } from './routes/migrate.js';
import { workflowsRouter } from './routes/workflows.js';
import { workflowAuthRouter, workflowGoogleCallback } from './routes/workflowAuth.js';
import { mcpRouter } from './routes/mcp.js';

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
app.use('/api/migrate', migrateRouter);
app.use('/api/workflows', workflowsRouter);
app.use('/mcp', mcpRouter);
app.use('/api/workflow', workflowAuthRouter);
// Workflow-specific Google OAuth callback (state prefix: "workflow:")
app.get('/callback/workflow/google', workflowGoogleCallback);
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
