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
import { upsertAuthSession } from '../db/repos/authSessions.js';
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
/**
 * `u` is the app user who STARTED the flow, carried through the redirect so the callback can
 * confirm the browser that comes back is the one that left. It is signed, not client-supplied,
 * so it is trustworthy — but it is still only ever used to CROSS-CHECK the auth cookie, never
 * as the owner on its own. The cookie remains the authority; this catches the case where a
 * different user signed in mid-flow, which would otherwise attach one person's cloud
 * connection to another person's session.
 */
function putState(data: { msSessionId?: string; popup?: boolean; appUserId?: string }): string {
  const payload = Buffer.from(
    JSON.stringify({
      s: data.msSessionId ?? '',
      p: data.popup ? 1 : 0,
      u: data.appUserId ?? '',
      t: Date.now(),
    }),
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
): { msSessionId?: string; popup?: boolean; appUserId?: string; expired?: boolean } | null {
  if (!state || !state.includes('.')) return null;
  const [payload, sig] = state.split('.');
  const expected = createHmac('sha256', config.MS_CLIENT_SECRET).update(payload).digest('base64url');
  if (sig !== expected) return null;
  try {
    const { s, p, u, t } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      s?: string;
      p?: number;
      u?: string;
      t: number;
    };
    const popup = p === 1;
    if (Date.now() - t > STATE_TTL_MS) return { popup, expired: true };
    return { msSessionId: s || undefined, popup, appUserId: u || undefined };
  } catch {
    return null;
  }
}

const web = (path: string) => `${config.WEB_ORIGIN.split(',')[0]?.trim()}${path}`;

// Same allowlist the CORS middleware in server.ts builds from config.WEB_ORIGIN — kept as
// its own const here rather than imported, since server.ts doesn't export it and this is a
// one-line derivation, not shared logic worth a module for.
const WEB_ORIGINS = config.WEB_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean);

/**
 * Popup-mode OAuth response: instead of navigating the whole app away, the OAuth
 * flow runs in a small window; on completion we serve this tiny page that posts
 * the result back to the opener (main app) and closes itself — GEM_CO-style UX.
 *
 * `postMessage`'s targetOrigin must be a single exact origin, never a list — passing
 * the raw, possibly comma-separated config.WEB_ORIGIN broke every deployment with more
 * than one allowed origin (confirmed live 2026-08-23: postMessage silently rejected with
 * "target origin ... does not match the recipient window's origin", so a popup-based
 * connect could complete on the server and the main window would never find out). The
 * popup is always opened BY one of our own already-CORS-approved origins, so the request
 * that lands here carries that real origin in its own Origin/Referer header — match it
 * against the same allowlist CORS uses, and echo back that one, not the whole list.
 */
function popupResult(req: Request, res: Response, type: string, payload: Record<string, unknown> = {}): void {
  const msg = JSON.stringify({ type, ...payload });
  const requestOrigin = req.headers.origin || (req.headers.referer ? new URL(req.headers.referer).origin : undefined);
  const matched = requestOrigin && WEB_ORIGINS.includes(requestOrigin) ? requestOrigin : WEB_ORIGINS[0];
  const origin = JSON.stringify(matched);
  res.type('html').send(
    `<!doctype html><meta charset="utf-8"><title>Connecting…</title>` +
      `<body style="font:14px system-ui,sans-serif;padding:28px;color:#334">Connected — you can close this window.` +
      `<script>(function(){try{window.opener&&window.opener.postMessage(${msg},${origin});}catch(e){}` +
      `setTimeout(function(){window.close();},60);})();</script></body>`,
  );
}

/**
 * Resume the most recent connected session for the SIGNED-IN user — so cloud connections
 * persist across a page refresh instead of being lost with the URL id.
 *
 * Scoped to the caller. Resuming by placeholder id used to hand whoever asked the newest
 * connected session in the whole database, which on a multi-customer install means handing
 * one customer another customer's live cloud connection. Unauthenticated callers get
 * nothing rather than someone else's session.
 */
authRouter.get('/resume', async (req, res) => {
  if (!req.appUser) return void res.json({ session: null });
  const id = await findLatestConnectedSession(req.appUser.appUserId);
  // Installs that predate sign-in have their sessions under the placeholder owner. Falling
  // back keeps those users working until `rekeyAppUser.ts` is run; once it is, this branch
  // finds nothing and the scoped lookup above is the only path.
  const legacy = id ?? (await findLatestConnectedSession(DEFAULT_APP_USER_ID));
  res.json({ session: legacy });
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
authRouter.post('/logout', async (_req, res) => {
  // Deliberately does NOT delete the migration session any more.
  //
  // It used to, on the reasoning that otherwise the Back button plus /resume would hand
  // the cloud connections straight back. That reasoning does not survive contact with the
  // guards that now exist: every /api/* migration route sits behind `requireAuth` (401
  // `not_signed_in`) and `enforceSessionOwnership`, and /resume itself returns null
  // without `req.appUser`. A signed-out browser holding a stale `?session=` id can do
  // nothing with it. The cookie is what makes signing out mean something, not the delete.
  //
  // What the delete DID accomplish was destroying both cloud connections on every sign
  // out, so the next sign-in showed Microsoft and Google disconnected and the customer
  // re-ran two OAuth flows to get back to where they were. The credentials themselves
  // were never gone -- `authSessions` keeps them and logout never touched that row -- so
  // the tool was discarding only the link to them, and calling that security.
  //
  // Signing out is not disconnecting. Disconnecting is its own button (POST /disconnect),
  // it revokes per platform, and it is the thing that should end a connection.
  res.json({ ok: true });
});

// ── Microsoft ────────────────────────────────────────────────────────────────
authRouter.get('/microsoft/start', (req, res) => {
  const session = req.query.session as string | undefined;
  res.redirect(
    ms.buildAuthUrl(
      putState({
        msSessionId: session,
        popup: req.query.popup === '1',
        appUserId: req.appUser?.appUserId,
      }),
    ),
  );
});

export async function msCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error } = req.query as Record<string, string>;
  const st = takeState(state);
  const popup = !!st?.popup;
  if (error) {
    if (popup) return void popupResult(req, res, 'ms-auth-error', { error });
    return void res.redirect(web(`/?error=${encodeURIComponent(error)}`));
  }
  if (!st || st.expired) {
    if (popup) return void popupResult(req, res, 'ms-auth-error', { error: 'state_expired' });
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

    // dvToken/dvOrgUrl pin to the first environment with agents, for whatever
    // still needs a single representative org. counts, shown as the tenant-wide
    // "found" summary on Connect, must total every environment — probing all of
    // them here (not stopping at the first with bots > 0) is what makes that sum
    // match what the pairing panel's per-row counts add up to.
    let dvToken = '';
    let dvOrgUrl = '';
    const counts = { bots: 0, topics: 0, knowledgeSources: 0, flows: 0 };
    for (const env of environments) {
      try {
        const t = await ms.clientCredsToken(tenantId, env.url);
        const inv = await inventory(env.url, t);
        counts.bots += inv.bots;
        counts.topics += inv.topics;
        counts.knowledgeSources += inv.knowledgeSources;
        counts.flows += inv.flows;
        if (!dvToken && inv.bots > 0) {
          dvToken = t;
          dvOrgUrl = env.url;
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
    // The cookie is the authority on who this is; the signed state only cross-checks it.
    // A mismatch means the signed-in user CHANGED between start and callback (another login
    // in the same browser), and attaching this cloud connection to whoever is signed in now
    // would hand one person's tenant credentials to another's session.
    const caller = req.appUser?.appUserId;
    if (st.appUserId && caller && st.appUserId !== caller) {
      logger.warn(
        { startedBy: st.appUserId, finishedBy: caller },
        'microsoft callback: signed-in user changed mid-flow — refusing to attach the connection',
      );
      const detail = 'Your sign-in changed while connecting. Start the connection again.';
      if (popup) return void popupResult(req, res, 'ms-auth-error', { error: detail });
      return void res.redirect(web(`/?error=${encodeURIComponent(detail)}`));
    }

    const linked = st.msSessionId ? await getSession(st.msSessionId) : undefined;
    // Reattaching to a session someone else owns is a cross-tenant write: the linked id
    // travels through the browser, so a stale id left by a previous login on the same
    // machine would otherwise silently graft this tenant onto that user's migration.
    // Falling through to a fresh session is the safe answer, not an error.
    const existing = linked && (!linked.appUserId || !caller || linked.appUserId === caller)
      ? linked
      : undefined;
    if (linked && !existing) {
      logger.warn(
        { session: st.msSessionId, owner: linked.appUserId, caller },
        'microsoft callback: linked session belongs to another user — minting a fresh one',
      );
    }
    let sessionId: string;
    if (existing) {
      sessionId = st.msSessionId!;
      await updateSession(sessionId, { step: existing.gEmail ? 'ready' : 'ms_done', ...msFields });
    } else {
      // A migration session is minted here, and its owner decides who can ever read the
      // customer's environments, staged agents and connector credentials. Creating one
      // without a signed-in user is what produced the 'default' bucket in the first
      // place, so it is refused rather than defaulted. The cookie is present: this
      // callback is a same-origin navigation, so a signed-in browser carries it.
      const owner = req.appUser?.appUserId;
      if (!owner) {
        const detail = 'Sign in to CloudFuze before connecting a cloud, so the connection has an owner.';
        if (popup) return void popupResult(req, res, 'ms-auth-error', { error: detail });
        return void res.redirect(web(`/?error=${encodeURIComponent(detail)}`));
      }
      sessionId = await createSession({ step: 'ms_done', appUserId: owner, ...msFields });
    }

    // Durable record of the CONNECTION, separate from the migration session that happens to
    // be using it. Keyed by (owner, provider, account email), so consenting again for the
    // same mailbox updates one row rather than accumulating copies — that key is the dedupe.
    // Best-effort: the session above already carries the live tokens for this run, so a
    // failed persist costs durability, not the connection.
    const connectionOwner = req.appUser?.appUserId ?? (existing?.appUserId as string | undefined);
    if (connectionOwner && msEmail) {
      await upsertAuthSession({
        appUserId: connectionOwner,
        provider: 'microsoft',
        email: msEmail,
        displayName: orgName,
        tenantId,
        refreshToken,
        expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000) : undefined,
      });
    }

    // Land back on the platform screen so the user sees "1 cloud connected".
    if (popup) return void popupResult(req, res, 'ms-auth-success', { session: sessionId });
    res.redirect(web(`/home?session=${sessionId}`));
  } catch (err) {
    logger.error({ err }, 'microsoft callback failed');
    if (popup) return void popupResult(req, res, 'ms-auth-error', { error: (err as Error).message });
    res.redirect(web(`/?error=${encodeURIComponent((err as Error).message)}`));
  }
}
authRouter.get('/microsoft/callback', msCallback);

// ── Google ───────────────────────────────────────────────────────────────────
authRouter.get('/google/start', async (req, res) => {
  const session = req.query.session as string;
  const popup = req.query.popup === '1';
  if (!(await getSession(session))) {
    if (popup) return void popupResult(req, res, 'google-auth-error', { error: 'session_expired' });
    return void res.redirect(web('/?error=session_expired'));
  }

  // The client's own admin signs in via OAuth. Their email + discovered Gemini
  // project drive the run; privileged writes use CloudFuze's service account
  // (Direct IAM or Domain-Wide Delegation), never a hardcoded impersonation.
  res.redirect(
    google.buildAuthUrl(putState({ msSessionId: session, popup, appUserId: req.appUser?.appUserId })),
  );
});

export async function googleCallback(req: Request, res: Response): Promise<void> {
  const { code, state, error } = req.query as Record<string, string>;
  const st = takeState(state);
  const popup = !!st?.popup;
  if (error) {
    if (popup) return void popupResult(req, res, 'google-auth-error', { error });
    return void res.redirect(web(`/?error=${encodeURIComponent(error)}`));
  }
  if (!st || st.expired || !st.msSessionId || !(await getSession(st.msSessionId))) {
    const errMsg = !st || st.expired ? 'state_expired' : 'session_expired';
    if (popup) return void popupResult(req, res, 'google-auth-error', { error: errMsg });
    return void res.redirect(web(`/?error=${errMsg}`));
  }
  // Same cross-check as the Microsoft callback: a different signed-in user coming back means
  // the connection would land on the wrong person's session.
  {
    const caller = req.appUser?.appUserId;
    if (st.appUserId && caller && st.appUserId !== caller) {
      logger.warn(
        { startedBy: st.appUserId, finishedBy: caller },
        'google callback: signed-in user changed mid-flow — refusing to attach the connection',
      );
      const detail = 'Your sign-in changed while connecting. Start the connection again.';
      if (popup) return void popupResult(req, res, 'google-auth-error', { error: detail });
      return void res.redirect(web(`/?error=${encodeURIComponent(detail)}`));
    }
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
    // Durable record of the connection — see the Microsoft callback for why this is separate
    // from the migration session. The owner comes from the session that is being written to,
    // which was already ownership-checked when Microsoft connected.
    const linkedSession = await getSession(st.msSessionId);
    const connectionOwner = req.appUser?.appUserId ?? linkedSession?.appUserId;
    if (connectionOwner && gEmail) {
      await upsertAuthSession({
        appUserId: connectionOwner,
        provider: 'google',
        email: gEmail,
        refreshToken: gRefreshToken,
      });
    }

    // Back to the platform screen — now showing "2 of 2 clouds connected".
    if (popup) return void popupResult(req, res, 'google-auth-success', { session: st.msSessionId });
    res.redirect(web(`/home?session=${st.msSessionId}`));
  } catch (err) {
    logger.error({ err }, 'google callback failed');
    if (popup) return void popupResult(req, res, 'google-auth-error', { error: (err as Error).message });
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
