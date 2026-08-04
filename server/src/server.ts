import cors from 'cors';
import express from 'express';
import bcrypt from 'bcryptjs';
import { config } from './config.js';
import { logger } from './logger.js';
import { serviceAccountConfigured } from './auth/google.js';
import { connectMongo } from './db/mongo.js';
import { getDb, isDbConnected } from './db/core.js';
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

// Username/password login against seeded appUsers collection.
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) return void res.status(400).json({ error: 'Email and password required.' });
    if (!isDbConnected()) return void res.status(503).json({ error: 'Database unavailable.' });
    const db = getDb();
    const user = await db.collection('appUsers').findOne({ email: email.toLowerCase().trim() });
    if (!user) return void res.status(401).json({ error: 'Invalid email or password.' });
    const ok = await bcrypt.compare(password, user.password as string);
    if (!ok) return void res.status(401).json({ error: 'Invalid email or password.' });
    res.json({ ok: true, email: user.email, role: user.role });
  } catch (err) {
    logger.error({ err }, 'POST /api/login error');
    res.status(500).json({ error: 'Server error.' });
  }
});

// Sign out — clears the cf_user_email on the client side; server is stateless for this.
app.post('/api/logout', (_req, res) => {
  res.json({ ok: true });
});

// Agent chat stub — returns a helpful message until the Gemini/Dialogflow agent is wired.
app.post('/api/agent/chat', (req, res) => {
  const { text } = req.body as { text?: string };
  const lower = (text ?? '').toLowerCase();
  let reply = 'I\'m the CloudFuze migration assistant. Connect your Microsoft and Google accounts to get started.';
  if (lower.includes('start') || lower.includes('migrat')) {
    reply = 'To start a migration: connect both clouds (Step 1), map your environments (Step 2), then select agents or flows to migrate (Step 3).';
  } else if (lower.includes('status')) {
    reply = 'Check the migration progress in the Migrate step. Each agent shows created, deployed, and verified status.';
  } else if (lower.includes('flow') || lower.includes('topic')) {
    reply = 'In the Select step, switch to the Flows tab to pick individual conversation topics from your Copilot Studio agents.';
  } else if (lower.includes('help') || lower.includes('what')) {
    reply = 'I can help you migrate AI agents from Microsoft Copilot Studio to Google Gemini Enterprise. Start by connecting both clouds.';
  }
  res.json({ text: reply, quickReplies: ['How do I start?', 'What gets migrated?', 'Check status'] });
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
