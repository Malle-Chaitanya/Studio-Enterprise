import { Router } from 'express';
import { runMigration } from '../orchestrator.js';
import { renderReport } from '../services/report.js';
import { resolveScope } from '../services/scope.js';
import { getSession, updateSession } from '../sessionStore.js';
import type { DestinationOptions, MigrationResult, MigrationScope } from '../types.js';

export const migrateRouter = Router();

/**
 * Resolve a migration scope into a concrete plan, store it on the session, and
 * return a preview (what will migrate + destination naming). Call before /stream.
 */
migrateRouter.post('/plan', async (req, res) => {
  const { session: sessionId, scope, destination, dryRun, knowledgeHandling } = req.body as {
    session?: string;
    scope?: MigrationScope;
    destination?: DestinationOptions;
    dryRun?: boolean;
    knowledgeHandling?: 'skip' | 'appendix' | 'report-only';
  };
  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!scope) return void res.status(400).json({ error: 'scope_required' });

  try {
    const dest = destination ?? { prefixWithEnv: false };
    const plan = await resolveScope(session, scope, dest);
    plan.dryRun = !!dryRun;
    // Customer choice for unsupported-website knowledge (default: report-only).
    if (knowledgeHandling === 'skip' || knowledgeHandling === 'appendix' || knowledgeHandling === 'report-only') {
      plan.knowledgeHandling = knowledgeHandling;
    }
    await updateSession(sessionId!, { plan });
    res.json({
      totalAgents: plan.totalAgents,
      environments: plan.units.map((u) => ({ name: u.envName, agents: u.bots.map((b) => b.name) })),
      destination: plan.destination,
      dryRun: plan.dryRun,
    });
  } catch (err) {
    res.status(500).json({ error: 'plan_failed', detail: (err as Error).message });
  }
});

/** SSE stream that runs the session's stored plan and emits progress events. */
migrateRouter.get('/stream', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  if (!session.plan) {
    res.status(400).json({ error: 'no_plan' });
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  try {
    for await (const evt of runMigration(session, session.plan)) {
      if (closed) break;
      send(evt);
    }
  } catch (err) {
    send({ type: 'log', level: 'fail', msg: `Fatal: ${(err as Error).message}` });
    send({ type: 'done', summary: 'Migration failed unexpectedly.', results: [] });
  } finally {
    res.end();
  }
});

/** Render a markdown report from client-held results (for download). */
migrateRouter.post('/report', (req, res) => {
  const { orgName, results } = req.body as { orgName?: string; results?: MigrationResult[] };
  if (!Array.isArray(results)) {
    res.status(400).json({ error: 'results_required' });
    return;
  }
  res.type('text/markdown').send(renderReport(orgName ?? 'Organization', results));
});
