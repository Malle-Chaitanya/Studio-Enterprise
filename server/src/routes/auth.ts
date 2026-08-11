import { createHmac } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import * as google from '../auth/google.js';
import * as ms from '../auth/microsoft.js';
import { engineReachable, projectReachable, resolveDestination } from '../services/gemini.js';
import { inventory } from '../services/dataverse.js';
import {
  createSession,
  deleteSession,
  DEFAULT_APP_USER_ID,
  findLatestConnectedSession,
  getSession,
  type Session,
  unsetFieldsOnMatchingSessions,
  unsetSessionFields,
  updateSession,
} from '../sessionStore.js';
import { logger } from '../logger.js';

export const authRouter = Router();

/**
 * Verify CloudFuze's service account can reach the client's Gemini engine.
 * Production model is DIRECT IAM (SA granted a Discovery Engine role on the
 * client's project) — tried first, no impersonation. Falls back to Domain-Wide
 * Delegation (impersonating the admin) for clients who authorize it that way.
 * The engine is always DISCOVERED (client-agnostic) — never a hardcoded id.
 */
async function verifySaReachable(
  geminiProject: string,
  adminEmail: string,
): Promise<{ saOk: boolean; saReason?: string }> {
  if (!google.serviceAccountConfigured()) {
    return { saOk: false, saReason: 'Migration service account not configured on the CloudFuze side.' };
  }
  if (!geminiProject) {
    return { saOk: false, saReason: 'No Gemini project discovered for this Google account — connect an account with a Gemini Enterprise project.' };
  }
  // 1) DIRECT IAM (production): SA added to the client project with a Discovery
  //    Engine role. No impersonation.
  try {
    const direct = await google.getSaToken();
    if (await projectReachable(geminiProject, direct)) {
      const dest = await resolveDestination(geminiProject, direct);
      if (await engineReachable(dest, direct)) return { saOk: true };
      return { saOk: false, saReason: `Service account has access to project ${geminiProject} but found no reachable Gemini engine — confirm a Gemini Enterprise app (engine) exists and has seats.` };
    }
  } catch (err) {
    logger.warn({ err }, 'direct-SA reachability check failed; trying DWD');
  }
  // 2) DWD fallback: impersonate the client admin.
  try {
    const saToken = await google.getSaToken(adminEmail);
    const dest = await resolveDestination(geminiProject, saToken);
    const saOk = await engineReachable(dest, saToken);
    return saOk
      ? { saOk }
      : { saOk, saReason: `Connected as ${adminEmail}, but no reachable Gemini engine in project ${geminiProject}. Grant CloudFuze's service account the "Discovery Engine Admin" role on the project, or confirm the engine exists and has seats.` };
  } catch (err) {
    return {
      saOk: false,
      saReason: `CloudFuze's service account cannot reach project ${geminiProject}. Grant it the "Discovery Engine Admin" IAM role on the project (recommended), or authorize it in Domain-Wide Delegation (Admin Console → Security → API controls). (${(err as Error).message})`,
    };
  }
}

/**
 * What a CLIENT must grant to onboard the Google/Gemini side — the CloudFuze
 * service-account identity + the two ways to grant it access. The client's admin
 * uses this to authorize the tool (the Google equivalent of the M365 admin
 * consent). No secrets returned — only the SA's public identifiers.
 */
authRouter.get('/service-account', (_req, res) => {
  const email = google.serviceAccountEmail();
  const clientId = google.serviceAccountClientId();
  if (!email) return void res.status(404).json({ error: 'service_account_not_configured' });
  res.json({
    serviceAccountEmail: email,
    serviceAccountClientId: clientId,
    grantOptions: [
      {
        method: 'iam',
        summary: 'Simplest — grant our service account access to your Gemini project.',
        where: 'Google Cloud Console → IAM & Admin → IAM → Grant access',
        principal: email,
        role: 'Discovery Engine Admin (roles/discoveryengine.admin)',
      },
      {
        method: 'dwd',
        summary: 'Domain-Wide Delegation — authorize our SA to act as your admin.',
        where: 'Admin Console → Security → API controls → Domain-wide delegation → Add new',
        clientId,
        scopes: ['https://www.googleapis.com/auth/cloud-platform'],
      },
    ],
  });
});

/**
 * Stateless, HMAC-signed OAuth state — survives server restarts (no in-memory
 * Map to be wiped when tsx-watch reloads mid-login, which caused "state_expired").
 * The signed token carries the CSRF nonce + optional linked session + timestamp.
 */
const STATE_TTL_MS = 15 * 60 * 1000;
function putState(data: { msSessionId?: string; popup?: boolean }): string {
  const payload = Buffer.from(
    JSON.stringify({ s: data.msSessionId ?? '', p: data.popup ? 1 : 0, t: Date.now() }),
  ).toString('base64url');
  const sig = createHmac('sha256', config.MS_CLIENT_SECRET).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}
/**
 * `expired: true` is distinguished from a fully-null result so callers can
 * still tell popup vs full-page mode apart when only the age check failed —
 * the signed payload (including the popup flag) was otherwise perfectly
 * valid. Without this, an expired popup-mode state silently fell back to a
 * full-page redirect, navigating the popup instead of closing it, and the
 * opener's connectViaPopup() promise never resolved.
 */
function takeState(
  state: string | undefined,
): { msSessionId?: string; popup?: boolean; expired?: boolean } | null {
  if (!state || !state.includes('.')) return null;
  const [payload, sig] = state.split('.');
  const expected = createHmac('sha256', config.MS_CLIENT_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const { s, p, t } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      s?: string;
      p?: number;
      t: number;
    };
    const popup = p === 1;
    if (Date.now() - t > STATE_TTL_MS) return { popup, expired: true };
    return { msSessionId: s || undefined, popup };
  } catch {
    return null;
  }
}

const web = (path: string) => `${config.WEB_ORIGIN}${path}`;

/**
 * Popup-mode OAuth response: instead of navigating the whole app away, the OAuth
 * flow runs in a small window; on completion we serve this tiny page that posts
 * the result back to the opener (main app) and closes itself — GEM_CO-style UX.
 */
function popupResult(res: Response, type: string, payload: Record<string, unknown> = {}): void {
  const msg = JSON.stringify({ type, ...payload });
  const origin = JSON.stringify(config.WEB_ORIGIN);
  res.type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Connecting…</title>` +
      `<body style="font:14px system-ui,sans-serif;padding:28px;color:#334">Connected — you can close this window.` +
      `<script>(function(){try{window.opener&&window.opener.postMessage(${msg},${origin});}catch(e){}` +
      `setTimeout(function(){window.close();},60);})();</script></body>`,
  );
}

/**
 * Resume the most recent connected session for the (default) app user — so cloud
 * connections persist across logout/login instead of being lost with the URL id.
 */
authRouter.get('/resume', async (_req, res) => {
  const id = await findLatestConnectedSession(DEFAULT_APP_USER_ID);
  res.json({ session: id });
});

/**
 * POST /api/auth/logout  body: { session }
 *
 * End the session for real. The Sign out button used to POST to `/api/logout`, which
 * does not exist — the 404 was swallowed and the session stayed alive, so pressing
 * Back landed on a fully working wizard page and /resume would hand the same
 * connection straight back. Signing out has to mean something.
 *
 * Deleting the session deliberately also stops `/resume` returning it: resume exists so
 * a REFRESH does not lose the cloud connections, not so a sign-out can be undone with
 * the browser's Back button.
 *
 * Idempotent and never fails — a sign-out that errors would strand someone on a page
 * they are trying to leave.
 */
authRouter.post('/logout', async (req, res) => {
  const sessionId = (req.body as { session?: string })?.session ?? '';
  if (sessionId) {
    try {
      await deleteSession(sessionId);
    } catch (err) {
      logger.warn({ err }, 'logout: could not delete session');
    }
  }
  res.json({ ok: true });
});

// ── Microsoft ────────────────────────────────────────────────────────────────
authRouter.get('/microsoft/start', (req, res) => {
  const session = req.query.session as string | undefined;
  res.redirect(ms.buildAuthUrl(putState({ msSessionId: session, popup: req.query.popup === '1' })));
});

export async function msCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error } = req.query as Record<string, string>;
  const st = takeState(state);
  const popup = !!st?.popup;
  if (error) {
    if (popup) return void popupResult(res, 'ms-auth-error', { error });
    return void res.redirect(web(`/?error=${encodeURIComponent(error)}`));
  }
  if (!st || st.expired) {
    if (popup) return void popupResult(res, 'ms-auth-error', { error: 'state_expired' });
    return void res.redirect(web('/?error=state_expired'));
  }

  try {
    const tokens = await ms.exchangeCode(code);
    const adminToken = tokens.access_token;
    const refreshToken = tokens.refresh_token ?? '';
    const tenantId = ms.tenantIdFromToken(adminToken);
    const msEmail = ms.emailFromToken(adminToken);

    // getOrgName calls Microsoft Graph, so it needs a Graph-scoped token —
    // adminToken here is scoped to api.powerapps.com and would 401 on every call.
    const [orgName, environments] = await Promise.all([
      ms.graphTokenFromRefresh(tenantId, refreshToken).then((graphToken) =>
        graphToken ? ms.getOrgName(graphToken, tenantId.slice(0, 8)) : tenantId.slice(0, 8),
      ),
      ms.discoverEnvironments(tenantId),
    ]);

    // Find the first environment that actually has Copilot Studio agents.
    let dvToken = '';
    let dvOrgUrl = '';
    let counts = { bots: 0, topics: 0, knowledgeSources: 0, flows: 0 };
    for (const env of environments) {
      try {
        const t = await ms.clientCredsToken(tenantId, env.url);
        const inv = await inventory(env.url, t);
        if (inv.bots > 0) {
          dvToken = t;
          dvOrgUrl = env.url;
          counts = inv;
          break;
        }
      } catch (err) {
        logger.debug({ err, env: env.url }, 'env probe failed');
      }
    }

    // NOTE: agent extraction uses app-only (client_credentials) Dataverse tokens
    // (acquired in the env loop above). We deliberately do NOT exchange the refresh
    // token for a delegated Dataverse token — that needs separate admin consent for
    // the Dynamics resource, isn't required for extraction, and caused a noisy
    // AADSTS65001 warning on every callback.

    const msFields = {
      tenantId,
      orgName,
      msEmail,
      refreshToken,
      dvToken,
      dvOrgUrl,
      environments,
      botCount: counts.bots,
      topicCount: counts.topics,
      ksCount: counts.knowledgeSources,
      flowCount: counts.flows,
    };

    // Reconnecting after a source-only disconnect re-attaches to the SAME
    // session doc (so a surviving Google connection isn't orphaned) instead
    // of minting a new one — mirrors how google/start already links back via
    // msSessionId. Falls back to a fresh session if the linked id is gone.
    const existing = st.msSessionId ? await getSession(st.msSessionId) : undefined;
    let sessionId: string;
    if (existing) {
      sessionId = st.msSessionId!;
      await updateSession(sessionId, { step: existing.gEmail ? 'ready' : 'ms_done', ...msFields });
    } else {
      sessionId = await createSession({ step: 'ms_done', ...msFields });
    }

    // Land back on the platform screen so the user sees "1 cloud connected".
    if (popup) return void popupResult(res, 'ms-auth-success', { session: sessionId });
    res.redirect(web(`/home?session=${sessionId}`));
  } catch (err) {
    logger.error({ err }, 'microsoft callback failed');
    if (popup) return void popupResult(res, 'ms-auth-error', { error: (err as Error).message });
    res.redirect(web(`/?error=${encodeURIComponent((err as Error).message)}`));
  }
}
authRouter.get('/microsoft/callback', msCallback);

// ── Google ───────────────────────────────────────────────────────────────────
authRouter.get('/google/start', async (req, res) => {
  const session = req.query.session as string;
  const popup = req.query.popup === '1';
  if (!(await getSession(session))) {
    if (popup) return void popupResult(res, 'google-auth-error', { error: 'session_expired' });
    return void res.redirect(web('/?error=session_expired'));
  }

  // The client's own admin signs in via OAuth. Their email + discovered Gemini
  // project drive the run; privileged writes use CloudFuze's service account
  // (Direct IAM or Domain-Wide Delegation), never a hardcoded impersonation.
  res.redirect(google.buildAuthUrl(putState({ msSessionId: session, popup })));
});

export async function googleCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error } = req.query as Record<string, string>;
  const st = takeState(state);
  const popup = !!st?.popup;
  if (error) {
    if (popup) return void popupResult(res, 'google-auth-error', { error });
    return void res.redirect(web(`/?error=${encodeURIComponent(error)}`));
  }
  if (!st || st.expired || !st.msSessionId || !(await getSession(st.msSessionId))) {
    const errMsg = !st || st.expired ? 'state_expired' : 'session_expired';
    if (popup) return void popupResult(res, 'google-auth-error', { error: errMsg });
    return void res.redirect(web(`/?error=${errMsg}`));
  }

  try {
    const { accessToken: gToken, refreshToken: gRefreshToken } = await google.exchangeCode(code);
    const gEmail = await google.getUserEmail(gToken);
    const geminiProject = await google.discoverGeminiProject(gToken);

    // Verify CloudFuze's SA can reach the client's Gemini engine — DIRECT IAM
    // first (production), DWD fallback — with the engine DISCOVERED, never a
    // hardcoded id. Precise, actionable reason on failure.
    const { saOk, saReason } = await verifySaReachable(geminiProject, gEmail);

    await updateSession(st.msSessionId, {
      step: 'ready',
      gEmail,
      gToken,
      ...(gRefreshToken ? { gRefreshToken } : {}),
      geminiProject,
      saOk,
      saReason,
    });
    // Back to the platform screen — now showing "2 of 2 clouds connected".
    if (popup) return void popupResult(res, 'google-auth-success', { session: st.msSessionId });
    res.redirect(web(`/home?session=${st.msSessionId}`));
  } catch (err) {
    logger.error({ err }, 'google callback failed');
    if (popup) return void popupResult(res, 'google-auth-error', { error: (err as Error).message });
    res.redirect(web(`/?error=${encodeURIComponent((err as Error).message)}`));
  }
}
authRouter.get('/google/callback', googleCallback);

// ── Session summary (no secrets) ──────────────────────────────────────────────
authRouter.get('/session/:id', async (req, res) => {
  const s = await getSession(req.params.id);
  if (!s) return void res.status(404).json({ error: 'session_not_found' });
  res.json({
    step: s.step,
    orgName: s.orgName,
    msEmail: s.msEmail,
    tenantId: s.tenantId,
    environments: s.environments?.length ?? 0,
    botCount: s.botCount ?? 0,
    topicCount: s.topicCount ?? 0,
    ksCount: s.ksCount ?? 0,
    flowCount: s.flowCount ?? 0,
    gEmail: s.gEmail,
    geminiProject: s.geminiProject,
    saOk: s.saOk ?? false,
    saReason: s.saReason,
    connected: { microsoft: Boolean(s.dvToken), google: Boolean(s.gEmail) },
  });
});

/**
 * Disconnect a connected platform.
 *   - google:    clears the Google/Gemini connection, keeps the source session.
 *   - microsoft: clears the source fields only. If a Google connection is still
 *                on the doc, the doc survives (step: 'google_only') so Gemini
 *                stays connected — reconnecting Copilot Studio re-attaches to
 *                this same doc (see msCallback). Only deleted outright when
 *                nothing is left connected at all.
 */
authRouter.post('/disconnect', async (req, res) => {
  const { session, platform } = req.body as { session?: string; platform?: string };
  const s = await getSession(session ?? '');
  if (!s) return void res.status(404).json({ error: 'session_not_found' });
  const appUserId = s.appUserId ?? DEFAULT_APP_USER_ID;

  if (platform === 'google') {
    const fields: (keyof Session)[] = ['gEmail', 'gToken', 'gRefreshToken', 'geminiProject', 'saOk'];
    await unsetSessionFields(session!, fields);
    // Also clear this same Google account on any other duplicate session doc for this
    // app user (see unsetFieldsOnMatchingSessions) — otherwise a stale duplicate keeps
    // reporting it connected and the Login screen's resume picks it back up.
    if (s.gEmail) await unsetFieldsOnMatchingSessions(appUserId, { gEmail: s.gEmail }, fields);
    if (!s.dvToken) {
      // Nothing left connected on this doc at all — end it, same as the microsoft
      // branch below. Previously this never checked, so disconnecting Google last
      // left a permanently orphaned, nothing-connected session doc behind.
      await deleteSession(session!);
      return void res.json({ ok: true, platform: 'google', sessionEnded: true });
    }
    await updateSession(session!, { step: 'ms_done' });
    return void res.json({ ok: true, platform: 'google', sessionEnded: false });
  }
  if (platform === 'microsoft') {
    const fields: (keyof Session)[] = [
      'tenantId',
      'orgName',
      'msEmail',
      'refreshToken',
      'dvToken',
      'dvDelegatedToken',
      'dvOrgUrl',
      'environments',
      'botCount',
      'topicCount',
      'ksCount',
      'flowCount',
    ];
    await unsetSessionFields(session!, fields);
    if (s.tenantId) await unsetFieldsOnMatchingSessions(appUserId, { tenantId: s.tenantId }, fields);
    if (s.gEmail) {
      await updateSession(session!, { step: 'google_only' });
      return void res.json({ ok: true, platform: 'microsoft', sessionEnded: false });
    }
    await deleteSession(session!);
    return void res.json({ ok: true, platform: 'microsoft', sessionEnded: true });
  }
  res.status(400).json({ error: 'unknown_platform' });
});

/**
 * Legacy callback aliases matching the POC's registered redirect URIs
 * (/callback/microsoft, /callback/google) so existing OAuth app registrations
 * work without portal changes. Mounted at the app root.
 */
export const legacyAuthRouter = Router();
legacyAuthRouter.get('/callback/microsoft', msCallback);
legacyAuthRouter.get('/callback/google', googleCallback);
