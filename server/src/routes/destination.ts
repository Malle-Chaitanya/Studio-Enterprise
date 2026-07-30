import { Router } from 'express';
import { getSaToken } from '../auth/google.js';
import { listEngines, listProjects } from '../services/destination.js';
import { engineReachable } from '../services/gemini.js';
import { setUpSharePointConnector, getConnectorOperation } from '../services/geminiConnector.js';
import { sanitizeDataStoreId } from '../services/knowledgePlanner.js';
import { getSession, updateSession, DEFAULT_APP_USER_ID } from '../sessionStore.js';

export const destinationRouter = Router();

/**
 * Destination discovery API — powers the environment→engine mapping screen.
 * All read-only: lists what already exists. No project/engine creation (V1).
 */

/**
 * GET /api/destination/projects?session=…
 * Google Cloud projects the admin can access. Uses the stored OAuth token when
 * present; otherwise returns an empty list + the session's known project so the
 * UI can fall back to manual entry / the connected project.
 */
destinationRouter.get('/projects', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const projects = await listProjects(session.gToken);
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
 * each Copilot environment onto. Discovered via the service account.
 */
destinationRouter.get('/engines', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const project = (req.query.project as string) || session.geminiProject || '';
  if (!project) return void res.status(400).json({ error: 'project_required' });

  try {
    const saToken = await getSaToken(session.gEmail);
    const engines = await listEngines(project, saToken);
    res.json({ project, engines });
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
 * body: { session, clientId, clientSecret, tenantId, instanceUri }
 *
 * Kicks off Gemini's native SharePoint federated connector using the
 * CUSTOMER's OWN Entra app credentials — never CloudFuze's multi-tenant app
 * (see services/geminiConnector.ts). This starts a long-running Google
 * operation; poll GET .../sharepoint-connector/status for completion.
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
    clientId?: string;
    clientSecret?: string;
    tenantId?: string;
    instanceUri?: string;
  };
  const session = await getSession(body.session);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const { clientId, clientSecret, tenantId, instanceUri } = body;
  if (!clientId || !clientSecret || !tenantId || !instanceUri) {
    return void res.status(400).json({ error: 'connector_credentials_required' });
  }

  const collectionId = sanitizeDataStoreId(`${session.orgName || session.tenantId || body.session}-sharepoint`);
  try {
    const saToken = await getSaToken(session.gEmail);
    const project = session.geminiProject || '';
    if (!project) return void res.status(400).json({ error: 'project_required' });

    const result = await setUpSharePointConnector(
      project,
      'global',
      saToken,
      collectionId,
      `SharePoint (${session.orgName || tenantId})`,
      { clientId, clientSecret, tenantId, instanceUri },
    );
    if (!result.started) {
      await updateSession(body.session!, {
        sharepointConnector: { clientId, tenantId, instanceUri, collectionId, status: 'failed', error: result.error },
      });
      return void res.status(502).json({ error: 'connector_setup_failed', detail: result.error });
    }

    await updateSession(body.session!, {
      sharepointConnector: {
        clientId,
        tenantId,
        instanceUri,
        collectionId,
        operationName: result.operationName,
        status: 'pending',
      },
    });
    res.json({ started: true, collectionId, operationName: result.operationName });
  } catch (err) {
    res.status(502).json({ error: 'connector_setup_failed', detail: (err as Error).message });
  }
});

/**
 * GET /api/destination/sharepoint-connector/status?session=…
 * Poll the connector-creation operation. See the honesty note on the POST
 * route above — `done: true` means provisioning finished, not that the
 * connector is confirmed linked to a searchable app.
 */
destinationRouter.get('/sharepoint-connector/status', async (req, res) => {
  const sessionId = req.query.session as string;
  const session = await getSession(sessionId);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const sp = session.sharepointConnector;
  if (!sp) return void res.status(404).json({ error: 'connector_not_configured' });
  if (!sp.operationName || sp.status !== 'pending') {
    return void res.json({ status: sp.status, collectionId: sp.collectionId, error: sp.error });
  }

  try {
    const saToken = await getSaToken(session.gEmail);
    const op = await getConnectorOperation('global', saToken, sp.operationName);
    if (!op) return void res.json({ status: 'pending', collectionId: sp.collectionId });
    if (op.done) {
      const status = op.error ? 'failed' : 'done';
      await updateSession(sessionId, { sharepointConnector: { ...sp, status, error: op.error } });
      return void res.json({ status, collectionId: sp.collectionId, error: op.error });
    }
    res.json({ status: 'pending', collectionId: sp.collectionId });
  } catch (err) {
    res.status(502).json({ error: 'connector_status_failed', detail: (err as Error).message });
  }
});

// DEFAULT_APP_USER_ID import kept for future per-tenant scoping of discovery.
void DEFAULT_APP_USER_ID;
