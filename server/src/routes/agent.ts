import { Router } from 'express';
import { runAgentTurn } from '../agent/agentLoop.js';
import { clearHistory, loadHistory } from '../agent/history.js';
import { logger } from '../logger.js';
import { DEFAULT_APP_USER_ID, getSession } from '../sessionStore.js';

export const agentRouter = Router();

/**
 * POST /api/agent/chat
 * body: { session, message, step?, pathname?, confirmed?, confirmTool?, confirmArgs?, clientState? }
 * SSE stream of agent tokens / ui_event / chips / done.
 */
agentRouter.post('/chat', async (req, res) => {
  const sessionId = String(req.body?.session ?? '');
  const session = await getSession(sessionId);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const message = String(req.body?.message ?? '');
  if (!message && !req.body?.confirmed) {
    return void res.status(400).json({ error: 'message_required' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const emit = (event: Record<string, unknown>) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  try {
    await runAgentTurn(
      {
        sessionId,
        session,
        message,
        step: req.body?.step ? String(req.body.step) : undefined,
        pathname: req.body?.pathname ? String(req.body.pathname) : undefined,
        confirmed: !!req.body?.confirmed,
        confirmTool: req.body?.confirmTool ? String(req.body.confirmTool) : undefined,
        confirmArgs: (req.body?.confirmArgs as Record<string, unknown>) ?? undefined,
        clientState: req.body?.clientState,
      },
      emit,
    );
  } catch (e) {
    logger.warn(`agent chat failed: ${(e as Error).message}`);
    emit({ type: 'error', message: (e as Error).message });
    emit({ type: 'done' });
  }
  res.end();
});

/** GET /api/agent/history?session= */
agentRouter.get('/history', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const messages = await loadHistory(appUserId, String(req.query.session));
  res.json({ messages });
});

/** DELETE /api/agent/history?session= */
agentRouter.delete('/history', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  await clearHistory(appUserId, String(req.query.session));
  res.json({ ok: true });
});
