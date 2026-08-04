import { Router } from 'express';
import { readFileSync } from 'fs';
import { createSign } from 'crypto';
import { clientCredsToken } from '../auth/microsoft.js';
import { logger } from '../logger.js';
import { extractAllFlows, extractFlow, listFlows } from '../services/flowExtractor.js';
import { isHealthy as hermasHealthy, migrateFlow as hermasMigrate, buildConnectorPromptContext } from '../services/hermasClient.js';
import { mapFlow } from '../services/flowMapper.js';
import { deployFlow } from '../services/flowDeployer.js';
import { generateWorkflowToolSpec, registerWorkflowTool, attachToolToAgent } from '../services/workflowToolRegistrar.js';
import { provisionMigrationAgent } from '../services/dialogflowProvisioner.js';
import { runParallel } from '../services/parallelRunner.js';
import { scanConnectors } from '../services/connectorScanner.js';
import { CONNECTOR_REGISTRY } from '../services/connectorRegistry.js';
import { upsertSecret } from '../services/secretManager.js';
import { connectorSecretId } from '../services/connectorCredentials.js';
import {
  upsertAllFlows,
  getFlows,
  getFlow,
  setMigrating,
  setMigrated,
  setFailed,
  setFlagged,
  setUnsupported,
  saveAnswers,
  setParallelResult,
  refreshSessionSummary,
  getOrCreateSession,
  updateSession,
  logAttempt,
} from '../db/repos/workflowFlows.js';
import { getSession, updateSession as updateAuthSession, type Session } from '../sessionStore.js';
import { config } from '../config.js';
import type { FlowIR } from '../types.js';
import { getConnectorQuestions } from '../services/connectorRegistry.js';

export const workflowsRouter = Router();

const MAX_FIX_ATTEMPTS = 5;

// ── GET /api/workflows/status ─────────────────────────────────────────────────

workflowsRouter.get('/status', async (_req, res) => {
  const hermas = await hermasHealthy();
  res.json({ hermas: hermas ? 'ok' : 'unreachable', hermasUrl: config.HERMAS_URL });
});

// ── POST /api/workflows/execute ───────────────────────────────────────────────
// Called by Gemini Agent Builder HTTP tool. Executes a Cloud Workflow and polls
// for result synchronously (up to 15s). No session needed — server SA handles auth.
//
// Body: { workflow: string, project?: string, region?: string, args?: Record<string,unknown> }

workflowsRouter.post('/execute', async (req, res) => {
  const { workflow, project = config.GEMINI_PROJECT_FALLBACK, region = 'us-central1', args = {} } =
    req.body as { workflow?: string; project?: string; region?: string; args?: Record<string, unknown> };

  if (!workflow) return void res.status(400).json({ error: 'workflow is required' });
  if (!project) return void res.status(400).json({ error: 'project is required (or set GEMINI_PROJECT_FALLBACK)' });

  try {
    const gcpToken = await getServerSaToken();
    const execUrl = `https://workflowexecutions.googleapis.com/v1/projects/${project}/locations/${region}/workflows/${workflow}/executions`;

    const execRes = await fetch(execUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ argument: JSON.stringify(args) }),
    });

    const exec = await execRes.json() as { name?: string; state?: string; error?: { message?: string } };
    if (!execRes.ok) return void res.status(execRes.status).json({ error: exec.error?.message ?? 'Execution failed' });

    // Poll up to 15s for completion
    let result: Record<string, unknown> = { state: exec.state };
    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const pollRes = await fetch(`https://workflowexecutions.googleapis.com/v1/${exec.name!}`, {
        headers: { Authorization: `Bearer ${gcpToken}` },
      });
      const done = await pollRes.json() as { state?: string; result?: string; error?: { message?: string } };
      result = { state: done.state };
      if (done.state === 'SUCCEEDED') {
        const parsed = JSON.parse(done.result ?? '{}') as Record<string, unknown>;
        result = { state: 'SUCCEEDED', ...parsed };
        break;
      }
      if (done.state === 'FAILED') {
        return void res.status(500).json({ error: done.error?.message ?? 'Workflow failed', state: 'FAILED' });
      }
    }

    logger.info({ workflow, project, result }, 'workflow executed via /execute');
    res.json(result);
  } catch (err) {
    logger.error({ err, workflow, project }, '/execute failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/workflows/provision-agent ───────────────────────────────────────
// Provisions a Dialogflow CX agent with tools for all migrated workflows.
// Called automatically at end of migration, or manually to re-provision.
//
// Body: { session: string, env: string, gcpProject: string, gcpRegion?: string,
//         dfProject?: string, dfLocation?: string }

workflowsRouter.post('/provision-agent', async (req, res) => {
  const {
    session: sessionId,
    env,
    gcpProject,
    gcpRegion = 'us-central1',
    dfProject,
    dfLocation = 'us-central1',
  } = req.body as {
    session?: string;
    env?: string;
    gcpProject?: string;
    gcpRegion?: string;
    dfProject?: string;
    dfLocation?: string;
  };

  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!env) return void res.status(400).json({ error: 'env is required' });

  const project = gcpProject ?? config.GEMINI_PROJECT_FALLBACK ?? '';
  if (!project) return void res.status(400).json({ error: 'gcpProject is required' });

  const dfProj = dfProject ?? project;
  const appUserId = session.appUserId ?? 'default';

  try {
    const gcpToken = await getServerSaToken();

    // Load all migrated flows for this session
    const flows = await getFlows(appUserId, env, ['migrated']);
    if (flows.length === 0) {
      return void res.status(400).json({ error: 'No migrated flows found — run migration first' });
    }

    // Build tool definitions from migrated flows
    const tools = flows
      .filter(f => f.gcpWorkflowName)
      .map(f => {
        const ir = f.ir;
        const operationId = (f.gcpWorkflowName ?? ir.name)
          .replace(/[^a-zA-Z0-9]/g, '_').toLowerCase().substring(0, 64);

        // Extract named params from Manual trigger inputs, or fall back to generic
        const params: Record<string, { type: string; description: string; required?: boolean }> =
          ir.trigger.type === 'Manual' && ir.trigger.inputs
            ? Object.fromEntries(
                Object.entries(ir.trigger.inputs).map(([k, v]) => [
                  k.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase(),
                  { type: v.type ?? 'string', description: v.description ?? k, required: v.required },
                ]),
              )
            : { input: { type: 'object', description: 'Input data for the workflow' } };

        return {
          displayName: ir.name.substring(0, 64),
          operationId,
          description: `Trigger the migrated workflow: ${ir.name}. Originally a Power Automate flow (${ir.trigger.type}).`,
          gcpProject: project,
          gcpRegion,
          gcpWorkflow: f.gcpWorkflowName!,
          params,
        };
      });

    const webhookUrl = `${config.PUBLIC_BASE_URL}/api/workflows/dialogflow-webhook`;
    const agentDisplayName = `SE Migration Agent — ${new URL(env).hostname.split('.')[0]}`;

    const result = await provisionMigrationAgent({
      gcpToken,
      project: dfProj,
      location: dfLocation,
      agentDisplayName,
      tools,
      webhookUrl,
    });

    logger.info({ agentId: result.agentId, toolsCount: tools.length }, 'agent provisioned');
    res.json({
      agentId: result.agentId,
      consoleUrl: result.consoleUrl,
      webhookUrl,
      toolsRegistered: tools.length,
      toolIds: result.toolIds,
      playbookId: result.playbookId,
    });
  } catch (err) {
    logger.error({ err }, 'provision-agent failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── GET /api/workflows/connector-questions ────────────────────────────────────
// Returns the connector-choice question list for a given flow.
// Query params: flowId (required), env (optional — used when flow not in DB yet)

workflowsRouter.get('/connector-questions', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const flowId = req.query.flowId as string;
  if (!flowId) return void res.status(400).json({ error: 'flowId_required' });

  const env = req.query.env as string;
  const appUserId = session.appUserId ?? 'default';

  try {
    // Try MongoDB first; fall back to live Dataverse extraction
    let ir: FlowIR;
    const dbFlow = env ? await getFlow(appUserId, env, flowId) : null;

    if (dbFlow) {
      ir = dbFlow.ir;
    } else if (env) {
      const token = await clientCredsToken(session.tenantId ?? '', env);
      ir = await extractFlow(env, token, flowId);
    } else {
      return void res.status(400).json({ error: 'env_required_when_flow_not_in_db' });
    }

    const connectorIds = ir.connectors.map((c) => c.apiName);
    const questions = getConnectorQuestions(connectorIds);

    res.json({ flowId, flowName: ir.name, questions });
  } catch (err) {
    logger.error({ err, flowId }, 'connector-questions failed');
    res.status(502).json({ error: 'connector_questions_failed', detail: (err as Error).message });
  }
});

// ── GET /api/workflows/scan ───────────────────────────────────────────────────
// Scans Dataverse, upserts all flows to MongoDB, returns summary.

workflowsRouter.get('/scan', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const env = req.query.env as string;
  if (!env) return void res.status(400).json({ error: 'env_required' });

  const appUserId = session.appUserId ?? 'default';

  try {
    const token = await clientCredsToken(session.tenantId ?? '', env);
    const flows = await extractAllFlows(env, token);

    // Persist all flows to DB (upsert preserves existing status/answers)
    await upsertAllFlows(appUserId, env, flows);
    await getOrCreateSession(appUserId, env);
    await updateSession(appUserId, env, {
      totalFlows: flows.length,
      scannedAt: new Date(),
      status: 'ready',
    });

    const summary = flows.map(toSummary);

    res.json({
      total: flows.length,
      byTrigger: countBy(flows, (f) => f.trigger.type),
      byStrategy: countBy(flows, (f) => f.confidence.strategy),
      flows: summary,
    });
  } catch (err) {
    logger.error({ err, env }, 'workflow scan failed');
    res.status(502).json({ error: 'scan_failed', detail: (err as Error).message });
  }
});

// ── GET /api/workflows/list ───────────────────────────────────────────────────

// GET /api/workflows/list — two modes:
//   ?env=<url>  → list Power Automate flows from Dataverse (flows-branch usage)
//   (no env)    → return empty workflows list (WorkflowsPage usage, GCP Cloud Workflows not wired yet)
workflowsRouter.get('/list', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const env = req.query.env as string | undefined;

  // WorkflowsPage calls without ?env — return empty list until Cloud Workflows is wired
  if (!env) {
    return void res.json({ workflows: [] });
  }

  try {
    const token = await clientCredsToken(session.tenantId ?? '', env);
    const flows = await listFlows(env, token);
    res.json({ flows, workflows: flows });
  } catch (err) {
    res.status(502).json({ error: 'list_failed', detail: (err as Error).message });
  }
});

// ── GET /api/workflows/flow ───────────────────────────────────────────────────

workflowsRouter.get('/flow', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const env = req.query.env as string;
  const flowId = req.query.flowId as string;
  if (!env || !flowId) return void res.status(400).json({ error: 'env_and_flowId_required' });

  const appUserId = session.appUserId ?? 'default';

  try {
    // Try DB first (avoid re-fetching if already scanned)
    const dbFlow = await getFlow(appUserId, env, flowId);
    const ir = dbFlow ? dbFlow.ir : await (async () => {
      const token = await clientCredsToken(session.tenantId ?? '', env);
      return extractFlow(env, token, flowId);
    })();

    if ((req.query.format as string) === 'json') {
      return void res
        .type('application/json')
        .set('Content-Disposition', `attachment; filename="${ir.name.replace(/[^a-z0-9]+/gi, '_')}.ir.json"`)
        .send(JSON.stringify(ir, null, 2));
    }

    res.json({
      flow: toSummary(ir),
      gaps: ir.confidence.gaps,
      unmapped: ir.unmapped,
      dbStatus: dbFlow?.status ?? null,
      attempts: dbFlow?.attempts ?? 0,
      lastError: dbFlow?.lastError ?? null,
    });
  } catch (err) {
    res.status(502).json({ error: 'flow_failed', detail: (err as Error).message });
  }
});

// ── POST /api/workflows/answers ───────────────────────────────────────────────

workflowsRouter.post('/answers', async (req, res) => {
  const { session: sessionId, env, flowId, answers } = req.body as {
    session?: string; env?: string; flowId?: string; answers?: Record<string, string>;
  };

  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!env || !flowId || !answers) return void res.status(400).json({ error: 'env_flowId_answers_required' });

  const appUserId = session.appUserId ?? 'default';

  // Save to DB (also resets status to pending so it gets retried)
  await saveAnswers(appUserId, env, flowId, answers);

  // Also keep in session for backwards compat
  const existing = session.workflowAnswers ?? {};
  const updated: Session['workflowAnswers'] = {
    ...existing,
    [env]: { ...(existing[env] ?? {}), [flowId]: { ...(existing[env]?.[flowId] ?? {}), ...answers } },
  };
  await updateAuthSession(sessionId!, { workflowAnswers: updated });

  res.json({ saved: true, flowId, answeredGaps: Object.keys(answers).length });
});

// ── GET /api/workflows/progress ───────────────────────────────────────────────
// Returns current DB state without triggering migration.

workflowsRouter.get('/progress', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const env = req.query.env as string;
  if (!env) return void res.status(400).json({ error: 'env_required' });

  const appUserId = session.appUserId ?? 'default';

  try {
    const [migSession, flows] = await Promise.all([
      getOrCreateSession(appUserId, env),
      getFlows(appUserId, env),
    ]);

    res.json({
      session: migSession,
      flows: flows.map((f) => ({
        sourceId: f.sourceId,
        name: f.name,
        status: f.status,
        strategy: f.strategy,
        confidenceScore: f.confidenceScore,
        attempts: f.attempts,
        lastError: f.lastError,
        unsupportedReason: f.unsupportedReason,
        gcpWorkflowName: f.gcpWorkflowName,
        gcpWorkflowUrl: f.gcpWorkflowUrl,
        testPassed: f.testPassed,
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'progress_failed', detail: (err as Error).message });
  }
});

// ── GET /api/workflows/migrate/stream ────────────────────────────────────────
// SSE stream — migrates all pending flows, skips already-migrated.

workflowsRouter.get('/migrate/stream', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const env = req.query.env as string;
  if (!env) return void res.status(400).json({ error: 'env_required' });

  const gcpProjectId = req.query.gcpProject as string;
  const gcpRegion = (req.query.gcpRegion as string) ?? 'us-central1';
  const gcpAccessToken = req.query.gcpToken as string;

  if (!gcpProjectId || !gcpAccessToken) {
    return void res.status(400).json({ error: 'gcpProject_and_gcpToken_required' });
  }

  const appUserId = session.appUserId ?? 'default';

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  let closed = false;
  req.on('close', () => { closed = true; });

  try {
    await updateSession(appUserId, env, { status: 'migrating', startedAt: new Date() });
    send({ type: 'log', level: 'info', msg: 'Starting workflow migration' });

    // Load pending flows from DB (skip already migrated)
    const allFlows = await getFlows(appUserId, env, ['pending', 'flagged', 'failed']);

    if (allFlows.length === 0) {
      send({ type: 'log', level: 'info', msg: 'No pending flows — all already migrated or scanned first' });
      send({ type: 'done', summary: 'Nothing to migrate', results: [] });
      res.end();
      return;
    }

    send({ type: 'progress', pct: 5, msg: `${allFlows.length} flows to process` });

    const msToken = await clientCredsToken(session.tenantId ?? '', env).catch(() => '');
    const results: FlowMigrateResult[] = [];
    let done = 0;

    for (const flowDoc of allFlows) {
      if (closed) break;

      const ir = flowDoc.ir;
      const answers = flowDoc.customerAnswers;
      const start = Date.now();

      send({ type: 'log', level: 'info', msg: `Processing: ${ir.name}` });

      const result = await migrateOneFlow({
        ir,
        answers,
        appUserId,
        envUrl: env,
        gcpProjectId,
        gcpRegion,
        gcpAccessToken,
        msToken,
        paOrgUrl: env,
      });

      results.push(result);
      done++;

      // Log attempt to DB
      await logAttempt({
        appUserId,
        flowSourceId: ir.sourceId,
        envUrl: env,
        attemptNumber: flowDoc.attempts + 1,
        strategy: result.strategy,
        yamlGenerated: result.yamlGenerated ? '(generated)' : null,
        deployed: result.deployed,
        testPassed: result.testPassed ?? null,
        error: result.error ?? null,
        attemptedAt: new Date(),
        durationMs: Date.now() - start,
      });

      send({ type: 'flow', result });
      send({
        type: 'progress',
        pct: Math.round(5 + (done / allFlows.length) * 90),
        msg: `${done}/${allFlows.length}: ${ir.name} → ${result.status}`,
      });
    }

    await refreshSessionSummary(appUserId, env);

    const succeeded = results.filter((r) => r.status === 'migrated').length;
    const flagged = results.filter((r) => r.status === 'flagged').length;
    const failed = results.filter((r) => r.status === 'failed').length;
    const unsupported = results.filter((r) => r.status === 'unsupported').length;

    send({ type: 'progress', pct: 100, msg: 'Complete' });
    send({
      type: 'done',
      summary: `${succeeded} migrated, ${flagged} flagged, ${failed} failed, ${unsupported} unsupported`,
      results,
    });
  } catch (err) {
    logger.error({ err, env }, 'workflow migration stream failed');
    send({ type: 'log', level: 'fail', msg: `Fatal: ${(err as Error).message}` });
    send({ type: 'done', summary: 'Migration failed', results: [] });
  } finally {
    res.end();
  }
});

// ── POST /api/workflows/trigger/:gcpProject/:gcpRegion/:workflowName ──────────
// Proxy endpoint for Manual-trigger flows.
// Gemini Agent (via Dialogflow CX tool) posts named params here.
// Server uses its SA key to call the Workflow Executions API and returns result.

async function getServerSaToken(): Promise<string> {
  const keyJson =
    config.GOOGLE_SA_KEY_JSON ??
    (config.GOOGLE_SA_KEY_FILE ? readFileSync(config.GOOGLE_SA_KEY_FILE, 'utf8') : null);
  if (!keyJson) throw new Error('No SA key configured (GOOGLE_SA_KEY_JSON or GOOGLE_SA_KEY_FILE)');

  const key = JSON.parse(keyJson) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(
    JSON.stringify({
      iss: key.client_email, sub: key.client_email,
      aud: 'https://oauth2.googleapis.com/token',
      scope: 'https://www.googleapis.com/auth/cloud-platform',
      iat: now, exp: now + 3600,
    }),
  ).toString('base64url');
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${p}.${s}` }),
  });
  const j = await r.json() as { access_token?: string; error_description?: string };
  if (!j.access_token) throw new Error(`SA token failed: ${j.error_description ?? 'unknown'}`);
  return j.access_token;
}

workflowsRouter.post('/trigger/:gcpProject/:gcpRegion/:workflowName', async (req, res) => {
  const { gcpProject, gcpRegion, workflowName } = req.params;

  // Strip internal routing fields; remaining body = named workflow args
  const { _session: _s, ...params } = req.body as Record<string, unknown>;

  try {
    const gcpToken = await getServerSaToken();
    const execUrl =
      `https://workflowexecutions.googleapis.com/v1/projects/${gcpProject}` +
      `/locations/${gcpRegion}/workflows/${workflowName}/executions`;

    const execRes = await fetch(execUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ argument: JSON.stringify(params) }),
    });

    const body = await execRes.json() as { name?: string; state?: string; result?: string; error?: { message?: string } };
    if (!execRes.ok) {
      return void res.status(execRes.status).json({ error: body.error?.message ?? 'Execution failed' });
    }

    res.json({
      executionName: body.name,
      state: body.state,
      result: body.result ?? null,
    });
  } catch (err) {
    logger.error({ err, workflowName, gcpProject }, 'workflow trigger proxy failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── POST /api/workflows/dialogflow-webhook ────────────────────────────────────
// Dialogflow CX calls this when a function tool fires inside a Playbook.
// We receive the tool name + collected params, execute the Cloud Workflow, return result.
//
// Dialogflow Playbook webhook request shape:
//   { toolCall: { tool: "<tool resource name>", action: "<operationId>", inputParameters: {...} } }
// We respond with:
//   { toolCallResult: { outputParameters: { ... } } }

workflowsRouter.post('/dialogflow-webhook', async (req, res) => {
  const body = req.body as {
    toolCall?: {
      tool?: string;
      action?: string;
      inputParameters?: Record<string, unknown>;
    };
  };

  const toolCall = body.toolCall;
  if (!toolCall) {
    return void res.status(400).json({ error: 'No toolCall in request' });
  }

  const { action, inputParameters = {} } = toolCall;
  logger.info({ action, inputParameters }, 'dialogflow tool webhook called');

  // Dynamic routing: action name = workflow name with dashes→underscores
  // First check static demo map, then derive workflow name from action
  const STATIC_MAP: Record<string, { project: string; region: string; workflow: string }> = {
    send_google_chat_message: {
      project: 'studio-enterprise-migration',
      region: 'us-central1',
      workflow: 'test-google-chat-path',
    },
    agent_create_task_demo: {
      project: 'studio-enterprise-migration',
      region: 'us-central1',
      workflow: 'agent-create-task-demo',
    },
    create_task: {
      project: 'studio-enterprise-migration',
      region: 'us-central1',
      workflow: 'agent-create-task-demo',
    },
  };

  // Fall back: derive workflow name from action (underscores → dashes)
  const derivedWorkflow = (action ?? '').replace(/_/g, '-');
  const target = STATIC_MAP[action ?? ''] ?? {
    project: config.GEMINI_PROJECT_FALLBACK ?? 'studio-enterprise-migration',
    region: 'us-central1',
    workflow: derivedWorkflow,
  };

  if (!action) {
    return void res.status(400).json({ error: 'No action in toolCall' });
  }

  try {
    const gcpToken = await getServerSaToken();
    const execUrl =
      `https://workflowexecutions.googleapis.com/v1/projects/${target.project}` +
      `/locations/${target.region}/workflows/${target.workflow}/executions`;

    const execRes = await fetch(execUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        argument: JSON.stringify({ ...inputParameters, gcp_project: target.project }),
      }),
    });

    const exec = await execRes.json() as { name?: string; state?: string; error?: { message?: string } };
    if (!execRes.ok) {
      return void res.status(execRes.status).json({ error: exec.error?.message ?? 'Execution failed' });
    }

    // Poll for result (up to 15s) so Dialogflow gets the actual workflow output
    let message = `Workflow triggered. Execution: ${exec.name}`;
    let outputParams: Record<string, unknown> = { executionId: exec.name ?? 'unknown', state: exec.state ?? 'ACTIVE' };

    for (let i = 0; i < 10; i++) {
      await new Promise(r => setTimeout(r, 1500));
      const pollRes = await fetch(`https://workflowexecutions.googleapis.com/v1/${exec.name!}`, {
        headers: { Authorization: `Bearer ${gcpToken}` },
      });
      const done = await pollRes.json() as { state?: string; result?: string; error?: { message?: string } };
      if (done.state === 'SUCCEEDED') {
        const parsed = JSON.parse(done.result ?? '{}') as Record<string, unknown>;
        message = (parsed['message'] as string | undefined) ?? `Workflow completed successfully.`;
        outputParams = { state: 'SUCCEEDED', message, ...parsed };
        break;
      }
      if (done.state === 'FAILED') {
        message = `Workflow failed: ${done.error?.message ?? 'unknown error'}`;
        outputParams = { state: 'FAILED', message };
        break;
      }
    }

    // Dialogflow expects toolCallResult with outputParameters
    res.json({
      toolCallResult: {
        outputParameters: outputParams,
      },
    });
  } catch (err) {
    logger.error({ err, action }, 'dialogflow webhook execution failed');
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── Core migration logic ──────────────────────────────────────────────────────

interface MigrateOneFlowOpts {
  ir: FlowIR;
  answers: Record<string, string>;
  appUserId: string;
  envUrl: string;
  gcpProjectId: string;
  gcpRegion: string;
  gcpAccessToken: string;
  msToken: string;
  paOrgUrl: string;
  /** Optional: Dialogflow CX agent to register the migrated workflow as a tool */
  dfAgentId?: string;
  dfLocation?: string;
}

async function migrateOneFlow(opts: MigrateOneFlowOpts): Promise<FlowMigrateResult> {
  const { ir, answers, appUserId, envUrl, gcpProjectId, gcpRegion, gcpAccessToken, msToken, paOrgUrl } = opts;
  const { sourceId, name } = ir;
  const workflowName = name.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase().slice(0, 64);

  await setMigrating(appUserId, envUrl, sourceId);

  // ── 1. Unsupported immediately ────────────────────────────────────────────
  if (ir.confidence.strategy === 'unsupported') {
    const reason = ir.unmapped.length > 0
      ? `Unsupported constructs: ${ir.unmapped.join(', ')}`
      : 'No migration path for this flow type';
    await setUnsupported(appUserId, envUrl, sourceId, reason);
    return makeResult(ir, 'unsupported', { error: reason });
  }

  // ── 2. Flagged — missing required customer answers ────────────────────────
  const unansweredGaps = ir.confidence.gaps.filter((g) => !answers[g.id]);
  if (unansweredGaps.length > 0 && ir.confidence.strategy === 'hybrid') {
    await setFlagged(appUserId, envUrl, sourceId);
    return makeResult(ir, 'flagged', {
      error: `${unansweredGaps.length} gap(s) need customer input: ${unansweredGaps.map((g) => g.question).join('; ')}`,
    });
  }

  // ── 3. Generate YAML — mapper first, then Hermas ──────────────────────────
  let yaml = '';
  let strategy = ir.confidence.strategy;
  let warnings: string[] = [];
  let mapperUnsupportedReason: string | undefined;

  // Build connector context (includes third-party SM secret URLs for Hermas)
  const scannedConnectors = scanConnectors([ir]);
  const unknownConnectors = scannedConnectors.filter(
    (c) => !CONNECTOR_REGISTRY[c.connectorId] && answers[`connector_${c.connectorId}`] === 'hermas',
  );

  // Store third-party API keys in SM and collect their secret IDs
  if (unknownConnectors.length > 0) {
    for (const connector of unknownConnectors) {
      const id = connector.connectorId;
      // Look for credential fields in answers: e.g. shared_hubspot_api_key
      for (const field of ['api_key', 'client_id', 'client_secret', 'refresh_token', 'access_token']) {
        const rawVal = answers[`${id}_${field}`];
        if (rawVal) {
          const secretId = connectorSecretId(id, field);
          try {
            await upsertSecret(gcpAccessToken, gcpProjectId, secretId, rawVal);
            logger.info({ connectorId: id, field, secretId }, 'third-party connector cred stored in SM');
          } catch (err) {
            logger.warn({ err, connectorId: id, field }, 'could not store connector cred in SM (non-fatal)');
          }
        }
      }
    }
  }

  const connectorContext = buildConnectorPromptContext(scannedConnectors, answers, gcpProjectId);

  const mapResult = mapFlow(ir, answers, { useSecretManager: true, gcpProject: gcpProjectId });

  if (!mapResult.unsupported && mapResult.confidence >= 50) {
    yaml = mapResult.yaml;
    warnings = mapResult.warnings;
  } else {
    // Mapper can't handle it — send to Hermas
    strategy = 'hermas';
    try {
      const hermasResult = await hermasMigrate(ir, answers, { connectorContext });
      yaml = hermasResult.yaml_content ?? '';
      if (!yaml) {
        mapperUnsupportedReason = `Hermas failed: ${hermasResult.error ?? 'no YAML returned'}`;
      }
    } catch (err) {
      mapperUnsupportedReason = `Hermas error: ${(err as Error).message}`;
    }
  }

  if (!yaml) {
    const reason = mapperUnsupportedReason ?? mapResult.unsupportedReason ?? 'Could not generate YAML';
    await setUnsupported(appUserId, envUrl, sourceId, reason);
    return makeResult(ir, 'unsupported', { strategy, error: reason });
  }

  // ── 4. Deploy to customer GCP ─────────────────────────────────────────────
  let deployResult;
  try {
    deployResult = await deployFlow({
      projectId: gcpProjectId,
      region: gcpRegion,
      gcpAccessToken,
      workflowName,
      yaml,
      schedulerConfig: mapResult.schedulerConfig,
      pubSubConfig: mapResult.pubSubConfig,
    });
  } catch (err) {
    const error = `Deploy failed: ${(err as Error).message}`;
    await setFailed(appUserId, envUrl, sourceId, error);
    return makeResult(ir, 'failed', { strategy, yamlGenerated: true, error });
  }

  if (!deployResult.success) {
    // ── 5. Fix loop — send error + YAML back to Hermas, retry up to 5x ──────
    let fixedYaml = yaml;
    let lastError = deployResult.error ?? 'Deploy failed';
    let fixPassed = false;

    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      try {
        const fix = await hermasMigrate(ir, answers);
        if (fix.yaml_content) {
          fixedYaml = fix.yaml_content;
          const retry = await deployFlow({
            projectId: gcpProjectId,
            region: gcpRegion,
            gcpAccessToken,
            workflowName,
            yaml: fixedYaml,
            schedulerConfig: mapResult.schedulerConfig,
            pubSubConfig: mapResult.pubSubConfig,
          });
          if (retry.success) {
            deployResult = retry;
            fixPassed = true;
            break;
          }
          lastError = retry.error ?? 'Deploy failed after fix';
        }
      } catch (err) {
        lastError = (err as Error).message;
      }
    }

    if (!fixPassed) {
      await setFailed(appUserId, envUrl, sourceId, lastError);
      return makeResult(ir, 'failed', {
        strategy,
        yamlGenerated: true,
        deployed: false,
        error: `Failed after ${MAX_FIX_ATTEMPTS} fix attempts: ${lastError}`,
      });
    }
  }

  // ── 6. Parallel run — GCP workflow + PA flow, compare outputs ────────────
  const parallelResult = await runParallel({
    projectId: gcpProjectId,
    region: gcpRegion,
    gcpAccessToken,
    workflowName,
    testArgs: {},
    paOrgUrl,
    paMsToken: msToken,
    paWorkflowId: sourceId,
  });

  await setParallelResult(appUserId, envUrl, sourceId, {
    match: parallelResult.outputsMatch ?? false,
    paOutput: parallelResult.paOutput,
    gcpOutput: parallelResult.gcpOutput,
  });

  // If parallel run shows mismatch — retry via Hermas fix loop
  if (parallelResult.outputsMatch === false) {
    let fixedYaml = yaml;
    let mismatchFixed = false;

    for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
      try {
        const fix = await hermasMigrate(ir, answers);
        if (fix.yaml_content) {
          fixedYaml = fix.yaml_content;
          const retry = await deployFlow({
            projectId: gcpProjectId,
            region: gcpRegion,
            gcpAccessToken,
            workflowName,
            yaml: fixedYaml,
          });
          if (retry.testPassed) {
            mismatchFixed = true;
            deployResult = retry;
            break;
          }
        }
      } catch {
        // continue fix loop
      }
    }

    if (!mismatchFixed) {
      // Still wrong output — mark flagged for manual review, not failed
      await setFlagged(appUserId, envUrl, sourceId);
      return makeResult(ir, 'flagged', {
        strategy,
        yamlGenerated: true,
        deployed: true,
        testPassed: false,
        error: `Output mismatch after ${MAX_FIX_ATTEMPTS} fix attempts: ${parallelResult.matchDetails}`,
        gcpWorkflowUrl: deployResult.workflowUrl,
      });
    }
  }

  // ── 7a. Register as Dialogflow CX tool (optional) ────────────────────────
  let dfToolName: string | undefined;
  if (opts.dfAgentId) {
    try {
      const dfProject = gcpProjectId;
      const dfLocation = opts.dfLocation ?? 'global';
      const toolSpec = generateWorkflowToolSpec(ir, gcpProjectId, gcpRegion, workflowName, config.PUBLIC_BASE_URL);
      const toolResult = await registerWorkflowTool(gcpAccessToken, dfProject, dfLocation, opts.dfAgentId, toolSpec, name.substring(0, 64));
      await attachToolToAgent(gcpAccessToken, dfProject, dfLocation, opts.dfAgentId, toolResult.toolName);
      dfToolName = toolResult.toolName;
      logger.info({ workflowName, toolName: dfToolName }, 'workflow registered as Dialogflow CX tool');
    } catch (err) {
      logger.warn({ err, workflowName }, 'tool registration failed (non-fatal)');
    }
  }

  // ── 7. Success — persist to DB ────────────────────────────────────────────
  await setMigrated(appUserId, envUrl, sourceId, {
    gcpWorkflowName: workflowName,
    gcpYaml: yaml,
    gcpProjectId,
    gcpRegion,
    gcpWorkflowUrl: deployResult.workflowUrl,
    schedulerJobName: deployResult.schedulerJobName,
    pubSubTopicName: deployResult.pubSubTopicName,
    testPassed: deployResult.testPassed,
    testOutput: deployResult.testOutput,
    testError: deployResult.testError ?? null,
  });

  return makeResult(ir, 'migrated', {
    strategy,
    yamlGenerated: true,
    deployed: true,
    testPassed: deployResult.testPassed,
    warnings,
    gcpWorkflowUrl: deployResult.workflowUrl,
    schedulerJobName: deployResult.schedulerJobName,
    pubSubTopicName: deployResult.pubSubTopicName,
    dfToolName,
  });
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface FlowSummary {
  sourceId: string;
  name: string;
  statecode: number;
  trigger: { type: string; entity?: string; message?: string; recurrenceMinutes?: number };
  connectors: { displayName: string; apiName: string; known: boolean }[];
  confidence: { score: number; strategy: string; gapCount: number; unknownConnectors: string[] };
  unmapped: string[];
}

interface FlowMigrateResult {
  sourceId: string;
  name: string;
  status: 'migrated' | 'flagged' | 'failed' | 'unsupported';
  strategy: string;
  yamlGenerated: boolean;
  deployed: boolean;
  testPassed?: boolean;
  warnings?: string[];
  error?: string;
  gcpWorkflowUrl?: string;
  schedulerJobName?: string;
  pubSubTopicName?: string;
  dfToolName?: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeResult(
  ir: FlowIR,
  status: FlowMigrateResult['status'],
  extra: Partial<FlowMigrateResult> = {},
): FlowMigrateResult {
  return {
    sourceId: ir.sourceId,
    name: ir.name,
    status,
    strategy: ir.confidence.strategy,
    yamlGenerated: false,
    deployed: false,
    ...extra,
  };
}

function toSummary(flow: FlowIR): FlowSummary {
  return {
    sourceId: flow.sourceId,
    name: flow.name,
    statecode: flow.statecode,
    trigger: {
      type: flow.trigger.type,
      entity: flow.trigger.entity,
      message: flow.trigger.message,
      recurrenceMinutes: flow.trigger.recurrenceMinutes,
    },
    connectors: flow.connectors,
    confidence: {
      score: flow.confidence.score,
      strategy: flow.confidence.strategy,
      gapCount: flow.confidence.gaps.length,
      unknownConnectors: flow.confidence.unknownConnectors,
    },
    unmapped: flow.unmapped,
  };
}

function countBy<T>(arr: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of arr) {
    const k = key(item);
    counts[k] = (counts[k] ?? 0) + 1;
  }
  return counts;
}
