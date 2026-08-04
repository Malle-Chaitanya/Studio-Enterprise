/**
 * Express routes for Cloud Workflows GCP OAuth + Secret Manager setup.
 *
 * GET  /api/workflow/auth/google       — redirect to Google OAuth consent
 * GET  /api/workflow/auth/status       — token status for the session org
 * POST /api/workflow/setup-secrets     — store MS credentials in Secret Manager
 * GET  /callback/workflow/google       — OAuth callback (registered separately)
 */

import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { logger } from '../logger.js';
import {
  buildWorkflowAuthUrl,
  exchangeWorkflowCode,
  storeWorkflowToken,
  getWorkflowTokenStatus,
  getWorkflowGcpToken,
  getWorkflowSaEmail,
} from '../services/workflowGcpAuth.js';
import { setupMsCredentials } from '../services/secretManager.js';
import { provisionCustomerProject } from '../services/gcpProvisioning.js';
import { upsertConnectorCredentials } from '../services/connectorCredentials.js';
import type { ConnectorCred } from '../services/connectorCredentials.js';
import { DEFAULT_APP_USER_ID } from '../sessionStore.js';

export const workflowAuthRouter = Router();

// ── GET /api/workflow/auth/google ─────────────────────────────────────────────

workflowAuthRouter.get('/auth/google', (_req: Request, res: Response) => {
  const orgId = DEFAULT_APP_USER_ID;
  const state = `workflow:${orgId}`;
  const url = buildWorkflowAuthUrl(state);
  res.redirect(url);
});

// ── GET /api/workflow/auth/status ─────────────────────────────────────────────

workflowAuthRouter.get('/auth/status', async (_req: Request, res: Response) => {
  const orgId = DEFAULT_APP_USER_ID;
  const status = await getWorkflowTokenStatus(orgId);
  res.json(status);
});

// ── POST /api/workflow/setup-secrets ─────────────────────────────────────────

interface SetupSecretsBody {
  projectId?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  orgUrl?: string;
  workflowsSaEmail?: string;
}

workflowAuthRouter.post(
  '/setup-secrets',
  async (req: Request<object, object, SetupSecretsBody>, res: Response) => {
    const orgId = DEFAULT_APP_USER_ID;
    const { projectId, tenantId, clientId, clientSecret, orgUrl, workflowsSaEmail } = req.body;

    if (!projectId || !tenantId || !clientId || !clientSecret || !orgUrl) {
      res.status(400).json({ error: 'projectId, tenantId, clientId, clientSecret, orgUrl required' });
      return;
    }

    try {
      const gcpToken = await getWorkflowGcpToken(orgId);
      const saEmail =
        workflowsSaEmail ??
        `studio-enterprise-migration@${projectId}.iam.gserviceaccount.com`;

      const result = await setupMsCredentials(gcpToken, projectId, {
        tenantId, clientId, clientSecret, orgUrl,
      }, saEmail);

      res.json({ ok: true, secrets: Object.values(result.secretIds) });
    } catch (err) {
      logger.error({ err, orgId }, 'setup-secrets failed');
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ── POST /api/workflow/provision ─────────────────────────────────────────────

interface ProvisionBody {
  projectId?: string;
  removeCloudFuzeSa?: boolean;
}

workflowAuthRouter.post(
  '/provision',
  async (req: Request<object, object, ProvisionBody>, res: Response) => {
    const orgId = DEFAULT_APP_USER_ID;
    const { projectId, removeCloudFuzeSa } = req.body;

    if (!projectId) {
      res.status(400).json({ error: 'projectId is required' });
      return;
    }

    try {
      const gcpToken = await getWorkflowGcpToken(orgId);
      const result = await provisionCustomerProject(gcpToken, projectId, orgId, {
        removeCloudFuzeSa: removeCloudFuzeSa ?? false,
      });
      res.json({ ok: true, saEmail: result.saEmail, rolesGranted: result.rolesGranted });
    } catch (err) {
      logger.error({ err, orgId, projectId }, 'provision failed');
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ── POST /api/workflow/connector-credentials ──────────────────────────────────

interface ConnectorCredentialsBody {
  projectId?: string;
  connectorId?: string;
  creds?: ConnectorCred[];
}

workflowAuthRouter.post(
  '/connector-credentials',
  async (req: Request<object, object, ConnectorCredentialsBody>, res: Response) => {
    const orgId = DEFAULT_APP_USER_ID;
    const { projectId, connectorId, creds } = req.body;

    if (!projectId || !connectorId || !creds || !Array.isArray(creds)) {
      res.status(400).json({ error: 'projectId, connectorId, and creds[] are required' });
      return;
    }

    try {
      const gcpToken = await getWorkflowGcpToken(orgId);
      const saEmail = await getWorkflowSaEmail(orgId);

      if (!saEmail) {
        res.status(400).json({
          error: 'No Workflows SA found for this org — run /provision first',
        });
        return;
      }

      const result = await upsertConnectorCredentials(
        gcpToken,
        projectId,
        connectorId,
        creds,
        saEmail,
      );
      res.json({ ok: true, secretIds: result.secretIds });
    } catch (err) {
      logger.error({ err, orgId, projectId, connectorId }, 'connector-credentials failed');
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ── POST /api/workflow/ms-credentials ────────────────────────────────────────
// Customer provides their OWN Azure App Registration credentials.
// We validate by getting a test token, then store all 4 in their Secret Manager.
// No dependency on CloudFuze's Azure app in production.

interface MsCredentialsBody {
  projectId?: string;
  tenantId?: string;
  clientId?: string;
  clientSecret?: string;
  orgUrl?: string;
}

workflowAuthRouter.post(
  '/ms-credentials',
  async (req: Request<object, object, MsCredentialsBody>, res: Response) => {
    const orgId = DEFAULT_APP_USER_ID;
    const { projectId, tenantId, clientId, clientSecret, orgUrl } = req.body;

    if (!projectId || !tenantId || !clientId || !clientSecret || !orgUrl) {
      res.status(400).json({
        error: 'projectId, tenantId, clientId, clientSecret, orgUrl required',
      });
      return;
    }

    // Validate credentials before storing — try getting a Dataverse token
    try {
      const tokenRes = await fetch(
        `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: clientId,
            client_secret: clientSecret,
            scope: `https://${orgUrl}/.default`,
          }),
        },
      );
      const tokenJson = await tokenRes.json() as {
        access_token?: string;
        error?: string;
        error_description?: string;
      };
      if (!tokenJson.access_token) {
        res.status(400).json({
          error: `Invalid MS credentials: ${tokenJson.error_description ?? tokenJson.error ?? 'token request failed'}`,
        });
        return;
      }
      logger.info({ orgId, tenantId, orgUrl }, 'MS credentials validated successfully');
    } catch (err) {
      res.status(400).json({ error: `MS credential validation failed: ${(err as Error).message}` });
      return;
    }

    // Store in customer's Secret Manager
    try {
      const gcpToken = await getWorkflowGcpToken(orgId);
      const saEmail = await getWorkflowSaEmail(orgId);
      if (!saEmail) {
        res.status(400).json({ error: 'Run /provision first to create the customer SA' });
        return;
      }

      const result = await setupMsCredentials(gcpToken, projectId, {
        tenantId, clientId, clientSecret, orgUrl,
      }, saEmail);

      res.json({ ok: true, secrets: Object.values(result.secretIds) });
    } catch (err) {
      logger.error({ err, orgId }, 'ms-credentials storage failed');
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// ── GET /callback/workflow/google (mounted separately in server.ts) ───────────

export async function workflowGoogleCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error } = req.query as Record<string, string>;

  if (error) {
    logger.warn({ error }, 'workflowGoogleCallback: user denied consent');
    res.redirect(`${config.WEB_ORIGIN}/migration?error=${encodeURIComponent(error)}`);
    return;
  }

  if (!code || !state?.startsWith('workflow:')) {
    res.status(400).send('Bad callback — missing code or wrong state prefix');
    return;
  }

  const orgId = state.slice('workflow:'.length);

  try {
    const tokens = await exchangeWorkflowCode(code);
    await storeWorkflowToken(orgId, tokens);
    logger.info({ orgId, email: tokens.email }, 'workflow GCP token stored via OAuth');
    res.redirect(`${config.WEB_ORIGIN}/migration?gcp_connected=true`);
  } catch (err) {
    logger.error({ err, orgId }, 'workflowGoogleCallback exchange failed');
    res.redirect(
      `${config.WEB_ORIGIN}/migration?error=${encodeURIComponent((err as Error).message)}`,
    );
  }
}
