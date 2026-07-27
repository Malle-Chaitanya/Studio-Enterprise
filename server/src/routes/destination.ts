import { Router } from 'express';
import { getSaToken } from '../auth/google.js';
import { listEngines, listProjects } from '../services/destination.js';
import { engineReachable } from '../services/gemini.js';
import { getSession, DEFAULT_APP_USER_ID } from '../sessionStore.js';

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
  // Always surface the currently-connected project so the customer has at least
  // one selectable destination even without OAuth project enumeration.
  const current = session.geminiProject;
  if (current && !projects.some((p) => p.projectNumber === current || p.projectId === current)) {
    projects.unshift({ projectId: current, projectNumber: current, displayName: `${current} (connected)` });
  }
  res.json({ projects, manualEntry: projects.length === 0 });
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

// DEFAULT_APP_USER_ID import kept for future per-tenant scoping of discovery.
void DEFAULT_APP_USER_ID;
