import { Router } from 'express';
import {
  clientCredsToken,
  graphTokenFromRefresh,
  listGraphUsersFiltered,
} from '../auth/microsoft.js';
import { listWorkspaceUsersFilteredAsAdmin, withSaTokens } from '../auth/google.js';
import { listLicensedPrincipals, resolveDestination } from '../services/gemini.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { readAgentPermissions, listBots } from '../services/dataverse.js';
import { buildOrganizationProfile, destinationDomainsOf } from '../services/organizationProfile.js';
import {
  catalogPrincipalsFromPermissions,
  suggestMappings,
  type DiscoveredPrincipal,
} from '../services/identityMap.js';
import { getIdentityMap, putIdentityMap } from '../db/repos/identityMap.js';
import { getSourceUsers } from '../db/repos/sourceUsers.js';
import { DEFAULT_APP_USER_ID, getSession, type Session } from '../sessionStore.js';
import type { IdentityMapOverrides, OrganizationProfile, PrincipalRef } from '../types.js';

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
  const map = await getIdentityMap(appUserId, tenantId, session.geminiProject ?? '');
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
  const saved = await putIdentityMap(appUserId, tenantId, session.geminiProject ?? '', overrides);
  res.json({ tenantId, ...saved });
});

/**
 * The organization profile, cached per session.
 *
 * WHY. `buildOrganizationProfile` costs four outbound calls — a Graph token, Graph verified
 * domains, Workspace domains, and a 500-user Workspace directory read — and `/suggest` is now
 * called on every mount of the Map users screen. Going forward and back through the wizard
 * rebuilt it each time, including a SECOND full Workspace directory read on the same page
 * load that `/google-users` had just done.
 *
 * What it holds is verified tenant domains and the set of real Google accounts. Domains
 * change essentially never, so caching this is not a freshness trade in any meaningful sense
 * — unlike the user LISTS, which stay live because an offboarded account offered as a mapping
 * target is a real error.
 *
 * In-memory and per process: it is cheap to rebuild, so a restart losing it costs one rebuild
 * rather than correctness. `refresh: true` (the Rescan button) bypasses it.
 */
const PROFILE_TTL_MS = 10 * 60_000;
const profileCache = new Map<string, { at: number; profile: OrganizationProfile }>();

async function cachedOrganizationProfile(
  session: Session,
  refresh: boolean,
): Promise<OrganizationProfile> {
  const key = session.id;
  // No id means no safe cache key. Rebuilding is correct here — sharing one slot across
  // every id-less session would serve one tenant's verified domains to another.
  if (!key) return buildOrganizationProfile(session, new Date().toISOString());
  const hit = profileCache.get(key);
  if (!refresh && hit && Date.now() - hit.at < PROFILE_TTL_MS) return hit.profile;
  const profile = await buildOrganizationProfile(session, new Date().toISOString());
  profileCache.set(key, { at: Date.now(), profile });
  return profile;
}

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

  const profile = await cachedOrganizationProfile(session, req.body?.refresh === true);
  const existing = await getIdentityMap(appUserId, tenantId, session.geminiProject ?? '');
  const principals = (Array.isArray(req.body?.principals) ? req.body.principals : []) as PrincipalRef[];
  const suggested = suggestMappings(
    principals,
    profile.ownedDomains,
    existing,
    profile.google.verifiedUserEmails,
    destinationDomainsOf(profile),
  );
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
/**
 * GET /api/identity/ms-users?session=&q=&max=&all=1&live=1
 *
 * Serves the snapshot the ELT sweep took when the clouds connected, and only calls Graph when
 * there isn't one — or when the caller explicitly asks (`all=1` needs the unfiltered
 * directory, which the snapshot deliberately is not; `live=1` is Rescan).
 *
 * `source` and `capturedAt` are on the response so the screen can say where the list came
 * from and how old it is. A cached list that cannot admit to being cached is how an
 * offboarded account gets offered as a mapping target with nothing to explain it.
 */
identityRouter.get('/ms-users', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!session.refreshToken || !session.tenantId) {
    return void res.status(400).json({ error: 'microsoft_not_connected' });
  }

  const wantsLive = req.query.live === '1' || req.query.all === '1' || Boolean(req.query.q);
  if (!wantsLive) {
    const snap = await getSourceUsers(
      session.appUserId ?? DEFAULT_APP_USER_ID,
      session.tenantId,
    );
    if (snap?.users?.length) {
      return void res.json({
        users: snap.users,
        truncated: snap.truncated ?? false,
        filter: snap.filter,
        source: 'snapshot',
        capturedAt: snap.capturedAt,
      });
    }
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
    res.json({ users, truncated: users.length >= max, filter: stats, source: 'live' });
  } catch (e) {
    logger.warn(`listGraphUsers failed: ${(e as Error).message}`);
    res.status(502).json({ error: 'ms_users_failed', detail: (e as Error).message });
  }
});

/**
 * GET /api/identity/google-users?session=&q=&max=&project=
 * Destination directory for mapping targets only (not discovery source).
 *
 * `project` (comma-separated) is the actual project(s) the customer paired their
 * environment(s) to on the "Choose project → Choose app" screen — sent by the
 * client from its saved pairing. Falls back to session.geminiProject (the
 * project auto-discovered when Google connected) only when nothing has been
 * paired yet. This distinction matters: a customer can pair different
 * environments to different Gemini projects, each with its OWN separate
 * license pool (confirmed live 2026-08-24 — three genuinely different
 * projects, three disjoint license lists, for one tenant). Filtering against
 * only the auto-discovered project silently hid every licensed user who
 * wasn't on that one project, no matter what the customer actually chose.
 */
identityRouter.get('/google-users', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!session.gEmail) return void res.status(400).json({ error: 'google_not_connected' });

  const projectsParam = (req.query.project as string) || session.geminiProject || '';
  const projects = [...new Set(projectsParam.split(',').map((p) => p.trim()).filter(Boolean))];

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
    if (wantLicence && projects.length) {
      try {
        // One licence read per paired project, unioned — an environment paired to
        // project A and another paired to project B means either project's seats
        // are valid mapping targets. Direct IAM first, DWD second per project —
        // the same order verifySaReachable uses (routes/auth.ts). Reading only the
        // direct token was wrong for any customer whose org sets
        // constraints/iam.allowedPolicyMemberDomains: an outside service account
        // cannot be granted a role there AT ALL, so direct IAM is not a slow path
        // to fall back from, it is permanently unavailable. Observed live on
        // 2026-08-23 against project 505103737920 — the bare SA resolved zero
        // engines, listLicensedPrincipals 403'd, and licence filtering silently
        // switched itself off for a tenant where DWD was working the whole time.
        const perProject = await Promise.all(
          projects.map((project) =>
            withSaTokens(session.gEmail, async (saToken) => {
              const dest = await resolveDestination(project, saToken);
              return listLicensedPrincipals(dest, saToken);
            }).catch((e) => {
              logger.warn(`google-users: licence read failed for project ${project} — ${(e as Error).message}`);
              return null;
            }),
          ),
        );
        const readable = perProject.filter((s): s is Set<string> => s !== null);
        if (readable.length) {
          licenceCheck = 'applied';
          const licensed = new Set<string>();
          for (const set of readable) for (const email of set) licensed.add(email);
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
