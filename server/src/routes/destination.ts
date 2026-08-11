import { Router } from 'express';
import { config } from '../config.js';
import { getSaToken, refreshGoogleToken } from '../auth/google.js';
import { listEnginesResult, listProjects } from '../services/destination.js';
import { logger } from '../logger.js';
import { engineReachable } from '../services/gemini.js';
import { setUpSharePointConnector, getConnectorOperation, getConnectorDataStores, type SharePointConnectorCreds } from '../services/geminiConnector.js';
import { putEntraSecret, getEntraSecret } from '../services/secretManager.js';
import { connectorCollectionId, normalizeSharePointSiteUrl } from '../services/knowledgePlanner.js';
import { getSession, updateSession, DEFAULT_APP_USER_ID, type Session } from '../sessionStore.js';
import { chatWithAdkAgent, createAdkSession } from '../services/adkAgentChat.js';
import { listAdkDeployments } from '../db/repos/adkDeployments.js';
import { getEntraAppCredential, upsertEntraAppCredential } from '../db/repos/entraAppCredentials.js';
import {
  getKnowledgeConnector,
  upsertKnowledgeConnector,
  markKnowledgeConnectorStatus,
  listKnowledgeConnectors,
  deleteKnowledgeConnector,
} from '../db/repos/knowledgeConnectors.js';

export const destinationRouter = Router();

/**
 * Destination discovery API — powers the environment→engine mapping screen.
 * All read-only: lists what already exists. No project/engine creation (V1).
 */

/**
 * Google's OAuth access token dies after ~1hr with no refresh built into the
 * connect flow's own client (see auth/google.ts exchangeCode doc). Rather than
 * let project/engine discovery silently degrade once that happens, mint a
 * fresh token up front on every call when we have a refresh token stored —
 * cheap (one token endpoint round trip) and guarantees the list reflects live
 * IAM grants instead of a snapshot from whenever the admin last connected.
 * Sessions connected before 2026-08-07 have no gRefreshToken and fall back to
 * the (possibly stale) session.gToken unchanged — those need one reconnect to
 * pick up a refresh token; every session after keeps refreshing silently.
 */
async function freshGoogleUserToken(sessionId: string, session: Session): Promise<string | undefined> {
  if (!session.gRefreshToken) return session.gToken;
  const fresh = await refreshGoogleToken(session.gRefreshToken);
  if (!fresh) return session.gToken;
  if (fresh !== session.gToken) await updateSession(sessionId, { gToken: fresh });
  return fresh;
}

/**
 * GET /api/destination/projects?session=…
 * Google Cloud projects the admin can access. Uses the stored OAuth token when
 * present; otherwise returns an empty list + the session's known project so the
 * UI can fall back to manual entry / the connected project.
 */
destinationRouter.get('/projects', async (req, res) => {
  const sessionId = req.query.session as string;
  const session = await getSession(sessionId);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const userToken = await freshGoogleUserToken(sessionId, session);
  const projects = await listProjects(userToken);
  // Always surface the currently-connected/discovered project so the customer has
  // at least one selectable destination even without OAuth project enumeration.
  const current = session.geminiProject;
  if (current && !projects.some((p) => p.projectNumber === current || p.projectId === current)) {
    projects.unshift({ projectId: current, projectNumber: current, displayName: `${current} (connected)`, hasGeminiApp: true });
  }
  // defaultProject lets the UI pre-select the discovered destination (the common
  // case is "confirm", not "hunt through the list").
  res.json({ projects, manualEntry: projects.length === 0, defaultProject: current ?? '' });
});

/**
 * GET /api/destination/engines?session=…&project=…
 * Existing Agentspace engines in a project — the destinations the customer maps
 * each Copilot environment onto. Prefer SA (same identity as migrate writes);
 * fall back to the admin OAuth token when SA returns empty/403 — matches how
 * hasGeminiApp is probed on the projects list.
 */
destinationRouter.get('/engines', async (req, res) => {
  const sessionId = req.query.session as string;
  const session = await getSession(sessionId);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const project = (req.query.project as string) || session.geminiProject || '';
  if (!project) return void res.status(400).json({ error: 'project_required' });

  try {
    let via: 'sa' | 'oauth' | 'none' = 'none';
    let engines: Awaited<ReturnType<typeof listEnginesResult>>['engines'] = [];
    let lastError: string | undefined;

    try {
      const saToken = await getSaToken(session.gEmail);
      const saResult = await listEnginesResult(project, saToken);
      engines = saResult.engines;
      lastError = saResult.error;
      if (engines.length) via = 'sa';
    } catch (err) {
      lastError = (err as Error).message;
      logger.warn(`engines: SA token failed for ${project}: ${lastError}`);
    }

    const userToken = await freshGoogleUserToken(sessionId, session);
    if (!engines.length && userToken) {
      const oauthResult = await listEnginesResult(project, userToken);
      if (oauthResult.engines.length) {
        engines = oauthResult.engines;
        via = 'oauth';
        lastError = undefined;
      } else if (oauthResult.error) {
        lastError = oauthResult.error;
      }
    }

    res.json({
      project,
      engines,
      via,
      ...(engines.length === 0 && lastError ? { warning: lastError } : {}),
    });
  } catch (err) {
    res.status(502).json({ error: 'engines_failed', detail: (err as Error).message });
  }
});

/**
 * GET /api/destination/validate?session=…&project=…&engine=…
 * Confirm a chosen engine is reachable/writable before the customer commits it
 * as a destination (existing-only policy — this is the safety check).
 */
destinationRouter.get('/validate', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const project = (req.query.project as string) || session.geminiProject || '';
  const engine = (req.query.engine as string) || '';
  const assistant = (req.query.assistant as string) || 'default_assistant';
  if (!project || !engine) return void res.status(400).json({ error: 'project_and_engine_required' });

  try {
    const saToken = await getSaToken(session.gEmail);
    const ok = await engineReachable({ project, engine, assistant }, saToken);
    res.json({ reachable: ok });
  } catch (err) {
    res.status(502).json({ error: 'validate_failed', detail: (err as Error).message });
  }
});

/**
 * POST /api/destination/sharepoint-connector
 * body: { session, siteUrl, tenantId, clientId?, clientSecret? }
 *
 * Kicks off Gemini's native SharePoint federated connector using the
 * CUSTOMER's OWN Entra app credentials — never CloudFuze's multi-tenant app
 * (see services/geminiConnector.ts). This starts a long-running Google
 * operation; poll GET .../sharepoint-connector/status?session=…&siteUrl=… for
 * completion.
 *
 * One row per (customer, siteUrl) in knowledgeConnectors — a migration
 * touching several distinct SharePoint sites calls this once per site, not
 * once per whole session (see .claude/memory/decisions.md, per-site tracking).
 *
 * Credential reuse: if `tenantId` matches an already-onboarded tenant (see
 * db/repos/entraAppCredentials.ts) and the caller doesn't supply a new
 * clientSecret, the stored credential is fetched from Secret Manager and
 * reused — the admin only re-enters Entra credentials for a genuinely new
 * tenant. clientId/clientSecret are required in the body only when no stored
 * credential is found.
 *
 * Honesty note: `done` on that operation means Google finished provisioning
 * the collection/connector/data store — Google's own docs describe the last
 * step (linking it to an app so it's actually searchable) as console-driven,
 * with no documented REST equivalent. This route does not claim that step is
 * done; verify it in Cloud Console before relying on it in a live migration.
 */
destinationRouter.post('/sharepoint-connector', async (req, res) => {
  const body = req.body as {
    session?: string;
    siteUrl?: string;
    tenantId?: string;
    clientId?: string;
    clientSecret?: string;
  };
  const session = await getSession(body.session ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const siteUrlRaw = body.siteUrl?.trim();
  const tenantId = body.tenantId?.trim();
  if (!siteUrlRaw || !tenantId) return void res.status(400).json({ error: 'site_url_and_tenant_id_required' });
  // Knowledge sources often capture a document URL; Gemini needs the site root.
  const siteUrl = normalizeSharePointSiteUrl(siteUrlRaw);

  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const project = session.geminiProject || '';
  if (!project) return void res.status(400).json({ error: 'project_required' });

  try {
    const saToken = await getSaToken(session.gEmail);

    // Resolve credentials: reuse a stored per-tenant secret when available;
    // otherwise the caller must supply one (a genuinely new tenant).
    let creds: SharePointConnectorCreds | undefined;
    let newTenantOnboarding = false;
    if (!body.clientSecret && config.CLOUDFUZE_GCP_PROJECT) {
      const stored = await getEntraAppCredential(appUserId, tenantId);
      if (stored) {
        const secret = await getEntraSecret(saToken, stored.secretName);
        if (secret.ok && secret.plaintext) {
          creds = { clientId: stored.clientId, clientSecret: secret.plaintext, tenantId, instanceUri: siteUrl };
        }
      }
    }
    if (!creds) {
      if (!body.clientId || !body.clientSecret) {
        return void res.status(400).json({ error: 'connector_credentials_required' });
      }
      creds = { clientId: body.clientId, clientSecret: body.clientSecret, tenantId, instanceUri: siteUrl };
      newTenantOnboarding = true;
    }

    const collectionId = connectorCollectionId(session.orgName || tenantId, siteUrl);
    const result = await setUpSharePointConnector(
      project,
      'global',
      saToken,
      collectionId,
      `SharePoint (${session.orgName || tenantId}) — ${siteUrl}`,
      creds,
    );
    if (result.alreadyExists) {
      // The collectionId is a deterministic hash of the site URL — resubmitting
      // the same site naturally retries the same collection Google already
      // has. That's the idempotent design working correctly, not a failure:
      // look up what's actually there instead of erroring.
      const discovered = await getConnectorDataStores(project, 'global', saToken, collectionId);
      const status = discovered.dataStoreIds.length ? 'done' : 'pending';
      await upsertKnowledgeConnector({
        appUserId, kind: 'sharepoint', siteUrl, collectionId, tenantId,
        clientId: creds.clientId, status, dataStoreIds: discovered.dataStoreIds.length ? discovered.dataStoreIds : undefined,
      });
      return void res.json({ started: true, collectionId, alreadyExists: true, status });
    }
    if (!result.started) {
      await upsertKnowledgeConnector({
        appUserId, kind: 'sharepoint', siteUrl, collectionId, tenantId,
        clientId: creds.clientId, status: 'failed', error: result.error,
      });
      return void res.status(502).json({
        error: 'connector_setup_failed',
        detail: result.error || 'Google setUpDataConnector returned failure with no message',
        siteUrl,
        ...(siteUrl !== siteUrlRaw ? { originalUrl: siteUrlRaw } : {}),
      });
    }

    await upsertKnowledgeConnector({
      appUserId, kind: 'sharepoint', siteUrl, collectionId, tenantId,
      clientId: creds.clientId, operationName: result.operationName, status: 'pending',
    });

    // Best-effort: cache this tenant's credential in Secret Manager so the
    // NEXT new site under it skips straight to reuse. Never blocks the
    // response on failure — the connector itself already succeeded.
    if (newTenantOnboarding && config.CLOUDFUZE_GCP_PROJECT) {
      const secretId = `entra-${appUserId}-${tenantId}`.replace(/[^a-zA-Z0-9-]/g, '-').slice(0, 255);
      const put = await putEntraSecret(config.CLOUDFUZE_GCP_PROJECT, saToken, secretId, creds.clientSecret);
      if (put.ok && put.versionName) {
        await upsertEntraAppCredential(appUserId, tenantId, creds.clientId, put.versionName);
      }
    }

    res.json({ started: true, collectionId, operationName: result.operationName });
  } catch (err) {
    res.status(502).json({ error: 'connector_setup_failed', detail: (err as Error).message });
  }
});

/**
 * GET /api/destination/sharepoint-connector/status?session=…&siteUrl=…
 * Poll the connector-creation operation for ONE site. See the honesty note on
 * the POST route above — `done: true` means provisioning finished, not that
 * the connector is confirmed linked to a searchable app; the orchestrator's
 * insert phase does that attach step and records the real fidelity outcome.
 */
destinationRouter.get('/sharepoint-connector/status', async (req, res) => {
  const sessionId = req.query.session as string;
  const siteUrlRaw = (req.query.siteUrl as string) ?? '';
  const session = await getSession(sessionId);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!siteUrlRaw) return void res.status(400).json({ error: 'site_url_required' });
  const siteUrl = normalizeSharePointSiteUrl(siteUrlRaw);

  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const sp =
    (await getKnowledgeConnector(appUserId, 'sharepoint', siteUrl)) ??
    (siteUrlRaw !== siteUrl ? await getKnowledgeConnector(appUserId, 'sharepoint', siteUrlRaw) : null);
  if (!sp) return void res.status(404).json({ error: 'connector_not_configured' });
  if (!sp.operationName || sp.status !== 'pending') {
    return void res.json({ status: sp.status, collectionId: sp.collectionId, dataStoreIds: sp.dataStoreIds, error: sp.error });
  }

  try {
    const saToken = await getSaToken(session.gEmail);
    const op = await getConnectorOperation(saToken, sp.operationName);
    if (op.checkFailed) {
      // The LRO record itself is gone (confirmed live: Google 404s
      // "Requested operation ... not found" well after creation — these
      // records don't stay queryable indefinitely). Fall back to the
      // connector's own realtimeState on the Collection resource, which is
      // durable ground truth instead of a possibly-expired operation.
      if (session.geminiProject) {
        const discovered = await getConnectorDataStores(session.geminiProject, 'global', saToken, sp.collectionId);
        // A real dataStoreId is direct, definitive proof the connector
        // finished setting up — confirmed live: realtimeState came back
        // undefined in practice (parsing it isn't reliable), but the
        // presence of an actual data store id under the entity is not
        // ambiguous. Trust the stronger signal first.
        if (discovered.dataStoreIds.length || discovered.realtimeState === 'ACTIVE') {
          const dataStoreIds = discovered.dataStoreIds.length ? discovered.dataStoreIds : undefined;
          await markKnowledgeConnectorStatus(appUserId, 'sharepoint', siteUrl, { status: 'done', dataStoreIds });
          return void res.json({ status: 'done', collectionId: sp.collectionId, dataStoreIds });
        }
        if (discovered.realtimeState === 'FAILED' || discovered.realtimeState === 'INITIALIZATION_FAILED') {
          const error = `connector state: ${discovered.realtimeState}`;
          await markKnowledgeConnectorStatus(appUserId, 'sharepoint', siteUrl, { status: 'failed', error });
          return void res.json({ status: 'failed', collectionId: sp.collectionId, error });
        }
      }
      // Still couldn't determine a real state either way — surface the
      // original check error rather than silently reporting pending forever.
      return void res.json({ status: 'pending', collectionId: sp.collectionId, checkError: op.error });
    }
    if (op.done) {
      const status = op.error ? 'failed' : 'done';
      let dataStoreIds: string[] | undefined;
      if (status === 'done' && session.geminiProject) {
        const discovered = await getConnectorDataStores(session.geminiProject, 'global', saToken, sp.collectionId);
        if (discovered.dataStoreIds.length) dataStoreIds = discovered.dataStoreIds;
      }
      await markKnowledgeConnectorStatus(appUserId, 'sharepoint', siteUrl, { status, error: op.error, dataStoreIds });
      return void res.json({ status, collectionId: sp.collectionId, dataStoreIds, error: op.error });
    }
    res.json({ status: 'pending', collectionId: sp.collectionId });
  } catch (err) {
    res.status(502).json({ error: 'connector_status_failed', detail: (err as Error).message });
  }
});

/**
 * DELETE /api/destination/sharepoint-connector?session=…&siteUrl=…
 * Forgets our own tracking row for one site's connector so the next setup
 * attempt starts completely fresh — for re-testing, or when a customer
 * rotates their Entra secret and the old connector needs to be redone. Does
 * NOT delete anything on Google's side (the real Collection/DataConnector
 * resource) — that's a separate, real, irreversible action outside this tool.
 */
destinationRouter.delete('/sharepoint-connector', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const siteUrlRaw = req.query.siteUrl as string;
  if (!siteUrlRaw) return void res.status(400).json({ error: 'site_url_required' });
  const siteUrl = normalizeSharePointSiteUrl(siteUrlRaw);

  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  await deleteKnowledgeConnector(appUserId, 'sharepoint', siteUrl);
  if (siteUrlRaw !== siteUrl) await deleteKnowledgeConnector(appUserId, 'sharepoint', siteUrlRaw);
  res.json({ ok: true });
});

/**
 * GET /api/destination/connectors?session=…
 * Every knowledge connector (SharePoint/OneDrive) configured for this
 * customer across every site — powers the "N connectors need authorization"
 * batch panel instead of surfacing one connector at a time.
 */
destinationRouter.get('/connectors', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const connectors = await listKnowledgeConnectors(appUserId);
  res.json({ connectors });
});

/**
 * GET /api/destination/migrated-agents?session=…
 * Every ADK agent this customer has deployed, newest first — the picker for the
 * "test a migrated agent" panel. Scoped by the session's appUserId, never a
 * client-supplied one.
 */
destinationRouter.get('/migrated-agents', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const deployments = await listAdkDeployments(appUserId);
  res.json({
    agents: deployments.map((d) => ({
      agentId: d.agentId,
      // The UI only ever needs the id; keep the full resource server-side.
      reasoningEngineId: d.reasoningEngine.split('/').pop(),
      sourceId: d.sourceId,
      envUrl: d.envUrl,
      project: d.project,
      engine: d.engine,
      deployedAt: d.deployedAt,
    })),
  });
});

/**
 * POST /api/destination/agent-chat
 * Body: { session, reasoningEngineId, message, chatSessionId? }
 *
 * Send one message to a migrated ADK agent and return its reply. This is how a
 * customer verifies a migration actually behaves, without waiting on a Google
 * Workspace admin to publish the agent in the console.
 *
 * The reasoningEngineId is validated against this tenant's own deployments
 * before use — otherwise the endpoint would happily invoke any Reasoning Engine
 * id a client cared to guess, using OUR service-account credentials.
 */
destinationRouter.post('/agent-chat', async (req, res) => {
  const body = req.body as {
    session?: string;
    reasoningEngineId?: string;
    message?: string;
    chatSessionId?: string;
  };
  const session = await getSession(body.session ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!body.reasoningEngineId) return void res.status(400).json({ error: 'reasoning_engine_required' });
  if (!body.message?.trim()) return void res.status(400).json({ error: 'message_required' });

  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const owned = (await listAdkDeployments(appUserId)).find(
    (d) => d.reasoningEngine.split('/').pop() === body.reasoningEngineId,
  );
  if (!owned) return void res.status(404).json({ error: 'agent_not_found' });

  try {
    const saToken = await getSaToken(session.gEmail);
    // Reuse the caller's chat session so multi-turn history is kept; open one on
    // the first turn if the deployment supports sessions at all.
    const chatSessionId =
      body.chatSessionId ??
      (await createAdkSession(owned.project, saToken, body.reasoningEngineId, appUserId)) ??
      undefined;

    const result = await chatWithAdkAgent(owned.project, saToken, {
      reasoningEngineId: body.reasoningEngineId,
      message: body.message,
      userId: appUserId,
      sessionId: chatSessionId,
    });
    if (!result.ok) return void res.status(502).json({ error: 'agent_chat_failed', detail: result.error });

    res.json({
      answer: result.answer,
      chatSessionId,
      usedSearchTool: result.usedSearchTool,
      agentId: owned.agentId,
    });
  } catch (e) {
    logger.warn(`agent-chat failed: ${(e as Error).message}`);
    res.status(500).json({ error: 'agent_chat_failed', detail: (e as Error).message });
  }
});
