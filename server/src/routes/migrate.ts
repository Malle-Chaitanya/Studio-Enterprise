import { Router } from 'express';
import { runMigration } from '../orchestrator.js';
import { renderReport } from '../services/report.js';
import { resolveScope } from '../services/scope.js';
import { getSession, updateSession } from '../sessionStore.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveSystemUserEmail } from '../services/dataverse.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination } from '../services/gemini.js';
import { findCandidates } from '../services/graphSearch.js';
import { resolveShareUrlSmart } from '../services/graphFiles.js';
import { migrateSharePointDriveItem } from '../services/knowledgeDataStoreExecutor.js';
import type { DestinationOptions, GeminiDestination, MigrationResult, MigrationScope } from '../types.js';

export const migrateRouter = Router();

/**
 * Resolve a migration scope into a concrete plan, store it on the session, and
 * return a preview (what will migrate + destination naming). Call before /stream.
 */
migrateRouter.post('/plan', async (req, res) => {
  const { session: sessionId, scope, destination, dryRun } = req.body as {
    session?: string;
    scope?: MigrationScope;
    destination?: DestinationOptions;
    dryRun?: boolean;
  };
  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!scope) return void res.status(400).json({ error: 'scope_required' });

  try {
    const dest = destination ?? { prefixWithEnv: false };
    const plan = await resolveScope(session, scope, dest);
    plan.dryRun = !!dryRun;
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

/**
 * POST /api/migrate/knowledge-candidates
 * body: { session, envUrl, filename, modifiedByUserId?, sharePointSiteIds?: string[] }
 *
 * Search-and-confirm for SharePoint/OneDrive "upload and sync" knowledge
 * sources whose real target Copilot Studio hides behind an opaque
 * reference (see .claude/memory/decisions.md). Searches a deliberately
 * NARROW scope — the specific person who added the source (OneDrive) and/or
 * a caller-supplied, bounded list of SharePoint sites — never a tenant-wide
 * sweep. Returns CANDIDATES only; nothing is migrated until the customer
 * confirms one via /knowledge-source-confirm.
 */
migrateRouter.post('/knowledge-candidates', async (req, res) => {
  const body = req.body as {
    session?: string;
    envUrl?: string;
    filename?: string;
    modifiedByUserId?: string;
    sharePointSiteIds?: string[];
  };
  const session = await getSession(body.session);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!body.filename) return void res.status(400).json({ error: 'filename_required' });
  if (!session.tenantId) return void res.status(400).json({ error: 'session_missing_tenant' });

  try {
    const graphToken = await clientCredsToken(session.tenantId, 'https://graph.microsoft.com');

    let oneDriveOwnerEmail: string | undefined;
    if (body.modifiedByUserId && body.envUrl) {
      const dvToken = await clientCredsToken(session.tenantId, body.envUrl);
      oneDriveOwnerEmail = (await resolveSystemUserEmail(body.envUrl, dvToken, body.modifiedByUserId)) ?? undefined;
    }

    const candidates = await findCandidates(graphToken, body.filename, {
      oneDriveOwnerEmail,
      sharePointSiteIds: body.sharePointSiteIds,
    });
    res.json({ candidates, scopedToUser: oneDriveOwnerEmail ?? null });
  } catch (err) {
    res.status(502).json({ error: 'knowledge_candidates_failed', detail: (err as Error).message });
  }
});

/**
 * POST /api/migrate/knowledge-source-resolve-url
 * body: { session, url }
 *
 * Alternative to filename search for a "FederatedStructuredSearchSource"
 * knowledge source: a person opens the source in Copilot Studio's own
 * Knowledge editor, copies its "Knowledge URL" field (Copilot Studio resolves
 * this internally — there is no public API for it, see
 * .claude/memory/decisions.md), and pastes it here instead of reviewing a
 * filename-search candidate list. This is a STRONGER signal than a filename
 * search: it's Copilot Studio's own resolved answer, not a keyword guess.
 *
 * The URL sometimes points at a FOLDER rather than a file directly (confirmed
 * live) — handled by resolveShareUrlSmart: a folder with exactly one file is
 * as confident as a direct file link; a folder with several files still needs
 * a person to pick one from `candidates`, same as the search-candidate flow.
 */
migrateRouter.post('/knowledge-source-resolve-url', async (req, res) => {
  const body = req.body as { session?: string; url?: string };
  const session = await getSession(body.session);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!body.url) return void res.status(400).json({ error: 'url_required' });
  if (!session.tenantId) return void res.status(400).json({ error: 'session_missing_tenant' });

  try {
    const graphToken = await clientCredsToken(session.tenantId, 'https://graph.microsoft.com');
    const resolution = await resolveShareUrlSmart(graphToken, body.url);
    res.json(resolution);
  } catch (err) {
    res.status(502).json({ error: 'knowledge_source_resolve_url_failed', detail: (err as Error).message });
  }
});

/**
 * POST /api/migrate/knowledge-source-confirm
 * body: { session, agentId, driveId, itemId, name, dryRun?, project?, engine?, assistant? }
 *
 * The customer has confirmed which search candidate (or manually-supplied
 * drive item) is the real source — this fetches it via Graph and attaches it
 * to the migrated agent's knowledge, same pipeline regardless of how the
 * item was identified. Attaches directly onto the agent (same mechanism as
 * plain local uploads) — no GCS bucket required.
 *
 * dryRun=true runs everything (idempotency check, Graph resolve, byte
 * download) but stops before the Gemini upload/attach — proves the pipeline
 * works without writing to a live agent.
 */
migrateRouter.post('/knowledge-source-confirm', async (req, res) => {
  const body = req.body as {
    session?: string;
    agentId?: string;
    driveId?: string;
    itemId?: string;
    name?: string;
    dryRun?: boolean;
    project?: string;
    engine?: string;
    assistant?: string;
  };
  const session = await getSession(body.session);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!body.agentId || !body.driveId || !body.itemId || !body.name) {
    return void res.status(400).json({ error: 'agent_id_drive_id_item_id_and_name_required' });
  }
  if (!session.tenantId) return void res.status(400).json({ error: 'session_missing_tenant' });

  const project = body.project || session.geminiProject || '';
  if (!project) return void res.status(400).json({ error: 'project_required' });
  const dest: GeminiDestination = body.engine
    ? { project, engine: body.engine, assistant: body.assistant || 'default_assistant' }
    : defaultDestination(project);

  try {
    const [saToken, graphToken] = await Promise.all([
      getSaToken(session.gEmail),
      clientCredsToken(session.tenantId, 'https://graph.microsoft.com'),
    ]);
    const result = await migrateSharePointDriveItem(
      dest,
      saToken,
      graphToken,
      body.agentId,
      { driveId: body.driveId, itemId: body.itemId, name: body.name },
      body.dryRun === true,
    );
    if (result.error) {
      return void res.status(502).json({ error: 'knowledge_source_confirm_failed', detail: result.error, ...result });
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'knowledge_source_confirm_failed', detail: (err as Error).message });
  }
});
