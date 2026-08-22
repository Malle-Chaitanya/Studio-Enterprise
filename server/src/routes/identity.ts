import { Router } from 'express';
import {
  clientCredsToken,
  graphTokenFromRefresh,
  listGraphUsersFiltered,
} from '../auth/microsoft.js';
import { getSaToken, listWorkspaceUsersFilteredAsAdmin } from '../auth/google.js';
import { listLicensedPrincipals, resolveDestination } from '../services/gemini.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { readAgentPermissions, listBots } from '../services/dataverse.js';
import { buildOrganizationProfile } from '../services/organizationProfile.js';
import {
  catalogPrincipalsFromPermissions,
  suggestMappings,
  type DiscoveredPrincipal,
} from '../services/identityMap.js';
import { getIdentityMap, putIdentityMap } from '../db/repos/identityMap.js';
import { DEFAULT_APP_USER_ID, getSession } from '../sessionStore.js';
import type { IdentityMapOverrides, PrincipalRef } from '../types.js';

export const identityRouter = Router();

/**
 * Identity discovery + mapping APIs for the Map Users wizard step.
 * Discovers agent-touched principals only (not full Entra/Workspace dumps).
 */

type SelectionUnit = { env: string; botIds: string[]; name?: string };

function parseSelection(bodyOrQuery: unknown): SelectionUnit[] {
  if (!bodyOrQuery) return [];
  if (typeof bodyOrQuery === 'string') {
    try {
      return parseSelection(JSON.parse(bodyOrQuery));
    } catch {
      return [];
    }
  }
  if (!Array.isArray(bodyOrQuery)) return [];
  return bodyOrQuery
    .map((u) => {
      const env = String((u as SelectionUnit).env ?? '');
      const botIds = Array.isArray((u as SelectionUnit).botIds)
        ? (u as SelectionUnit).botIds.map(String)
        : [];
      const name = (u as SelectionUnit).name ? String((u as SelectionUnit).name) : undefined;
      return { env, botIds, name };
    })
    .filter((u) => u.env && u.botIds.length);
}

/**
 * POST /api/identity/principals
 * body: { session, selection: [{ env, botIds, name? }] }
 * Discovers owners / editors / viewers / chat groups for the selected agents.
 */
identityRouter.post('/principals', async (req, res) => {
  const sessionId = String(req.body?.session ?? '');
  const session = await getSession(sessionId);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const selection = parseSelection(req.body?.selection);
  if (!selection.length) return void res.status(400).json({ error: 'selection_required' });

  const tenantId = session.tenantId ?? '';
  const catalog = new Map<string, DiscoveredPrincipal>();
  const errors: { env: string; botId: string; error: string }[] = [];

  for (const unit of selection) {
    let token: string;
    try {
      token = await clientCredsToken(tenantId, unit.env);
    } catch (e) {
      errors.push({ env: unit.env, botId: '*', error: (e as Error).message });
      continue;
    }
    let nameById = new Map<string, string>();
    try {
      const bots = await listBots(unit.env, token);
      nameById = new Map(bots.map((b) => [b.botid, b.name]));
    } catch {
      /* names are nice-to-have */
    }
    for (const botId of unit.botIds) {
      try {
        const perms = await readAgentPermissions(unit.env, token, botId);
        const agentName = nameById.get(botId) ?? botId;
        catalogPrincipalsFromPermissions(botId, agentName, perms, catalog);
      } catch (e) {
        errors.push({ env: unit.env, botId, error: (e as Error).message });
        logger.warn({ err: e, botId, env: unit.env }, 'principal discovery failed');
      }
    }
  }

  // Enrich org-wide sentinel and strip it from "map" lists (not a real principal).
  const principals = [...catalog.values()].filter((p) => p.source.id !== 'org-wide');
  const orgWideAgentCount = [...catalog.values()]
    .filter((p) => p.role === 'org-wide')
    .reduce((n, p) => n + p.agentIds.length, 0);

  res.json({
    principals: principals.map((p) => ({
      key: p.key,
      role: p.role,
      type: p.source.type,
      id: p.source.id,
      email: p.source.email,
      displayName: p.source.displayName,
      agentCount: p.agentIds.length,
      agentNames: p.agentNames,
      geminiSeat: 'unknown' as const,
    })),
    orgWideAgentsReferenced: orgWideAgentCount,
    errors,
  });
});

/** GET /api/identity/map?session= */
identityRouter.get('/map', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const tenantId = session.tenantId ?? '';
  const map = await getIdentityMap(appUserId, tenantId);
  res.json({ tenantId, ...map });
});

/** PUT /api/identity/map  body: { session, users?, groups? } */
identityRouter.put('/map', async (req, res) => {
  const session = await getSession(String(req.body?.session ?? ''));
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const tenantId = session.tenantId ?? '';
  const overrides: IdentityMapOverrides = {
    users: (req.body?.users as Record<string, string>) ?? {},
    groups: (req.body?.groups as Record<string, string>) ?? {},
  };
  const saved = await putIdentityMap(appUserId, tenantId, overrides);
  res.json({ tenantId, ...saved });
});

/**
 * POST /api/identity/suggest
 * body: { session, principals?: PrincipalRef[] }
 * Auto-suggest same-email mappings for principals on owned domains.
 */
identityRouter.post('/suggest', async (req, res) => {
  const session = await getSession(String(req.body?.session ?? ''));
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const tenantId = session.tenantId ?? '';

  const profile = await buildOrganizationProfile(session, new Date().toISOString());
  const existing = await getIdentityMap(appUserId, tenantId);
  const principals = (Array.isArray(req.body?.principals) ? req.body.principals : []) as PrincipalRef[];
  const suggested = suggestMappings(principals, profile.ownedDomains, existing, profile.google.verifiedUserEmails);
  res.json({
    ownedDomains: profile.ownedDomains,
    suggested,
  });
});

/**
 * GET /api/identity/ms-users?session=&q=&max=
 * Microsoft Graph users for the early Map Users grid (not a full dump claim —
 * paginated/searchable directory listing for mapping).
 */
identityRouter.get('/ms-users', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!session.refreshToken || !session.tenantId) {
    return void res.status(400).json({ error: 'microsoft_not_connected' });
  }

  try {
    const token = await graphTokenFromRefresh(session.tenantId, session.refreshToken);
    if (!token) return void res.status(401).json({ error: 'graph_token_failed' });
    const max = Number(req.query.max) || 200;
    // `all=1` shows the unfiltered directory. An admin asking "why is this person missing
    // from the grid" needs to see the disabled/unlicensed account to get their answer;
    // without the escape hatch, the filter itself becomes unexplainable.
    const showAll = req.query.all === '1';
    const { users, stats } = await listGraphUsersFiltered(token, {
      max,
      query: (req.query.q as string) || undefined,
      activeOnly: showAll ? false : undefined,
      licensedOnly: showAll ? false : undefined,
    });
    res.json({ users, truncated: users.length >= max, filter: stats });
  } catch (e) {
    logger.warn(`listGraphUsers failed: ${(e as Error).message}`);
    res.status(502).json({ error: 'ms_users_failed', detail: (e as Error).message });
  }
});

/**
 * GET /api/identity/google-users?session=&q=&max=
 * Destination directory for mapping targets only (not discovery source).
 */
identityRouter.get('/google-users', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!session.gEmail) return void res.status(400).json({ error: 'google_not_connected' });

  try {
    const max = Number(req.query.max) || 200;
    const showAll = req.query.all === '1';
    const { users, excludedInactive } = await listWorkspaceUsersFilteredAsAdmin(session.gEmail, {
      max,
      query: (req.query.q as string) || undefined,
      activeOnly: showAll ? false : undefined,
    });

    // The licence that matters at the destination is a Gemini Enterprise SEAT, which lives
    // in Discovery Engine's user store, not in the Workspace directory. Read it in bulk and
    // intersect; a null result means the read failed, and then nothing is filtered on it —
    // an unreadable licence must never present as "nobody is licensed".
    let excludedUnlicensed = 0;
    let licenceCheck: 'applied' | 'unavailable' = 'unavailable';
    let out = users;
    const wantLicence = !showAll && config.DIRECTORY_LICENSED_ONLY;
    if (wantLicence && session.geminiProject) {
      try {
        const saToken = await getSaToken();
        const dest = await resolveDestination(session.geminiProject, saToken);
        const licensed = await listLicensedPrincipals(dest, saToken);
        if (licensed) {
          licenceCheck = 'applied';
          const kept = out.filter((u) => licensed.has(u.email));
          excludedUnlicensed = out.length - kept.length;
          out = kept;
        }
      } catch (e) {
        // Destination not resolvable yet (Google connected, engine not discovered). Show
        // the active directory rather than nothing — licenceCheck stays 'unavailable', so
        // the UI reports the list as unfiltered instead of implying everyone is licensed.
        logger.warn(`google-users: licence filter skipped — ${(e as Error).message}`);
      }
    }

    res.json({
      users: out,
      truncated: out.length >= max,
      filter: {
        returned: out.length,
        excludedInactive,
        excludedUnlicensed,
        excludedGuest: 0,
        excludedNoAddress: 0,
        licenceCheck,
      },
    });
  } catch (e) {
    logger.warn(`listWorkspaceUsers failed: ${(e as Error).message}`);
    res.json({ users: [], error: (e as Error).message });
  }
});
