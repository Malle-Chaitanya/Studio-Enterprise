import { Router } from 'express';
import { clientCredsToken } from '../auth/microsoft.js';
import { logger } from '../logger.js';
import { countBotComponents, extractAgent, inventory, listBots } from '../services/dataverse.js';
import {
  aclDisclosureFor,
  aclDisclosureSummary,
  needsAclAcknowledgement,
} from '../services/aclDisclosure.js';
import { normalizeSharePointSiteUrl } from '../services/knowledgePlanner.js';
import { assessAgent } from '../services/assess.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { getSession, DEFAULT_APP_USER_ID } from '../sessionStore.js';
import { requireAdmin } from '../auth/appAuth.js';
import { lastSweep, runEltSweep, sweepInFlight } from '../services/eltSweep.js';
import { purgeRawAgents, rawAgentStats, rawRetentionDays } from '../db/repos/rawAgents.js';
import { purgeCachedIR } from '../db/repos/agentIR.js';
import { purgeSweepResults } from '../db/repos/eltSweeps.js';
import { purgeSourceUsers } from '../db/repos/sourceUsers.js';
import { listCustomConnectors } from '../connectors/customConnectorInventory.js';
import { mapPoolCollect } from '../concurrency.js';
import {
  cacheEnvironments,
  getCachedEnvironments,
  type EnvInfo,
} from '../db/repos/environments.js';

export const exploreRouter = Router();

/**
 * Turn a failed environment probe into something the customer can act on.
 *
 * Dataverse answers `0x80072560 — The user is not a member of the organization` when our
 * app registration has no **application user** in that specific org. The token is fine and
 * tenant-wide; the grant is per-environment, which is why two of a tenant's four
 * environments can be invisible while the other two work perfectly. Reporting only
 * "no access (403)" leaves the customer with a dead end and silently narrows the migration
 * scope to whatever happened to be reachable.
 */
export function classifyEnvDenial(err: unknown): EnvInfo['accessDenied'] {
  const msg = (err as Error)?.message ?? String(err);
  if (/0x80072560|not a member of the organization/i.test(msg)) {
    return {
      code: 'no_application_user',
      detail: 'Dataverse: the user is not a member of the organization (0x80072560).',
      fix:
        'In the Power Platform admin center, open this environment → Settings → Users + permissions → ' +
        'Application users → New app user, add this app registration, and give it a role that can read ' +
        'bots and botcomponents (System Administrator or a custom read role). The grant is per-environment.',
    };
  }
  if (/\b40[13]\b|forbidden|unauthorized/i.test(msg)) {
    return { code: 'forbidden', detail: msg.slice(0, 300) };
  }
  return { code: 'unreachable', detail: msg.slice(0, 300) };
}

/**
 * Discovery + assessment API — powers the migration wizard's environment →
 * agent → assessment drill-down. All read-only; touches Copilot Studio only.
 */

/**
 * GET /api/explore/environments?session=…
 * Every environment in the tenant with its per-env inventory counts and an
 * accessibility flag. Cached per tenant (5 min) so the wizard is snappy.
 */
exploreRouter.get('/environments', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const tenantId = session.tenantId ?? '';
  const envs = session.environments ?? [];

  // Serve from cache when fresh.
  const cached = await getCachedEnvironments(appUserId, tenantId);
  if (cached) return void res.json({ environments: cached, cached: true });

  // Probe each environment's inventory in parallel; a failure (e.g. 403) just
  // marks the environment inaccessible rather than failing the whole request.
  const environments: EnvInfo[] = await Promise.all(
    envs.map(async (env): Promise<EnvInfo> => {
      const base: EnvInfo = {
        name: env.name || env.url,
        url: env.url,
        id: env.id,
        accessible: false,
        bots: 0,
        topics: 0,
        knowledgeSources: 0,
        flows: 0,
      };
      try {
        const token = await clientCredsToken(tenantId, env.url);
        const inv = await inventory(env.url, token);
        return { ...base, accessible: true, ...inv };
      } catch (err) {
        logger.debug({ err, env: env.url }, 'environment probe failed');
        return { ...base, accessDenied: classifyEnvDenial(err) };
      }
    }),
  );

  await cacheEnvironments(appUserId, tenantId, environments);
  res.json({ environments, cached: false });
});

/**
 * GET /api/explore/agents?session=…&env=…
 * Agent names in one environment (for the selection dropdown/checklist).
 */
exploreRouter.get('/agents', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const env = req.query.env as string;
  if (!env) return void res.status(400).json({ error: 'env_required' });

  try {
    const token = await clientCredsToken(session.tenantId ?? '', env);
    const agents = await listBots(env, token);
    // Counts come from one extra call for the whole environment, not one per agent. They
    // stay UNDEFINED when that call fails — see countBotComponents: a zero would claim the
    // agent has no topics, which an unrelated failure has no right to say.
    const counts = await countBotComponents(env, token);
    for (const a of agents) {
      const c = counts.get(a.botid);
      if (c) a.knowledgeCount = c.knowledge;
    }
    res.json({ agents });
  } catch (err) {
    res.status(502).json({ error: 'agents_failed', detail: (err as Error).message });
  }
});

/**
 * GET /api/explore/agent?session=…&env=…&botId=…&name=…&format=json?
 * Per-agent compatibility assessment (default) or the raw AgentIR as a JSON
 * download (format=json).
 */
exploreRouter.get('/agent', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const env = req.query.env as string;
  const botId = req.query.botId as string;
  const name = (req.query.name as string) || 'Agent';
  if (!env || !botId) return void res.status(400).json({ error: 'env_and_botId_required' });

  try {
    // Read the IR the connect-time sweep already landed. It was being re-extracted from
    // Dataverse on every visit while a complete copy sat in `agentIRCache` — the sweep
    // exists precisely so this page does not have to go back to the customer's tenant.
    const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
    const cached = await getCachedIR(appUserId, env, botId);
    let ir = cached?.ir;
    if (!ir) {
      const token = await clientCredsToken(session.tenantId ?? '', env);
      ir = await extractAgent(env, token, { botid: botId, name });
    }

    if ((req.query.format as string) === 'json') {
      res
        .type('application/json')
        .set('Content-Disposition', `attachment; filename="${name.replace(/[^a-z0-9]+/gi, '_')}.ir.json"`)
        .send(JSON.stringify(ir, null, 2));
      return;
    }

    // The permission-inversion verdict, computed by the SAME predicate the orchestrator's
    // gate uses. Without this the UI has to guess from "does this agent have knowledge
    // sources", which is wider than the truth — a public-website source has no permissions
    // to lose — and it would ask the operator to accept an exposure that is not happening.
    // Two implementations of one verdict is the failure this codebase keeps hitting; the
    // answer lives here, next to the gate that enforces it.
    const disclosure = aclDisclosureFor(ir);
    res.json({
      assessment: assessAgent(ir),
      permissionLoss: {
        /** True when migrating THIS agent inverts a permission — the gate's own condition. */
        inverts: needsAclAcknowledgement(ir),
        /** Which sources, and to whom they become readable. Empty when nothing inverts. */
        items: disclosure.items,
        orgWide: disclosure.orgWide,
        // ir.name, NOT the `name` query param: assessment.agent already uses the IR's own
        // name, and two names for one agent in one response disagree the moment a caller
        // passes a stale or missing one — the summary would then warn about the wrong agent
        // while the assessment beside it named the right one.
        summary: needsAclAcknowledgement(ir) ? aclDisclosureSummary(ir.name, disclosure) : '',
      },
    });
  } catch (err) {
    res.status(502).json({ error: 'assessment_failed', detail: (err as Error).message });
  }
});

export interface ConnectorNeeded {
  siteUrl: string;
  kind: 'sharepoint-connector' | 'onedrive-connector';
  agentNames: string[];
  /**
   * The same agents by botid. Names are not a key: the Connectors screen matches these
   * agents against the customer's selection, and an unmatched name silently dropped the
   * row while two agents sharing a display name collided. The id is already in scope
   * here, so carrying it costs nothing. Additive — existing consumers ignore it.
   */
  agentIds: string[];
}

/**
 * GET /api/explore/connectors-needed?session=…&env=…&botIds=…
 * Scans agents in one environment and returns ONE deduplicated list of sites
 * that need a native connector, each with every agent that references it.
 * Built so an admin never has to open agents one at a time just to find out
 * which SharePoint/OneDrive sites need setting up — this is the "batch" view
 * instead of a per-agent drill-down (see .claude/memory/decisions.md).
 * Bounded concurrency (mapPoolCollect) — never an unbounded fan-out at
 * Dataverse, per this project's code-style rule.
 *
 * botIds (optional, comma-separated): scan only these agents instead of
 * every bot in the environment — used by ConnectorConfig to scope this same
 * scan to whichever agents the user actually selected on SelectData, instead
 * of the unfiltered whole-environment sweep the standalone Connectors page uses.
 */
exploreRouter.get('/connectors-needed', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const env = req.query.env as string;
  if (!env) return void res.status(400).json({ error: 'env_required' });

  try {
    const token = await clientCredsToken(session.tenantId ?? '', env);
    const allBots = await listBots(env, token);

    // Scan ONLY the agents the customer selected, when the caller says which.
    // Scanning every agent in the environment was both slow (48 agents here, each a
    // full Dataverse extract) and wrong: it listed connectors belonging to agents the
    // customer had not chosen, which reads as "you must set all these up" when most
    // are irrelevant to this migration.
    const botIds = String(req.query.botIds ?? '')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);
    const bots = botIds.length ? allBots.filter((b) => botIds.includes(b.botid)) : allBots;

    const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
    // Concurrency 8 rather than 5: these are reads, and the previous setting made a
    // full-environment scan take minutes of wall clock with the UI showing nothing.
    const perAgent = await mapPoolCollect(bots, 8, async (bot) => {
      try {
        // Reuse the cached IR when we already extracted this agent. The cache existed
        // but nothing read from it, so every visit to this page re-extracted every
        // agent from Dataverse.
        const cached = await getCachedIR(appUserId, env, bot.botid);
        const ir = cached?.ir ?? (await extractAgent(env, token, bot));
        return { name: bot.name, id: bot.botid, actions: assessAgent(ir).knowledge?.actions ?? [] };
      } catch (err) {
        logger.debug({ err, bot: bot.name }, 'connectors-needed: agent extract failed');
        return { name: bot.name, id: bot.botid, actions: [] };
      }
    });

    const bySite = new Map<string, { siteUrl: string; kind: ConnectorNeeded['kind']; agentNames: Set<string>; agentIds: Set<string> }>();
    for (const { name, id, actions } of perAgent) {
      for (const a of actions) {
        if (a.target !== 'sharepoint-connector' && a.target !== 'onedrive-connector') continue;
        const siteUrlRaw = a.references?.[0];
        if (!siteUrlRaw) continue;
        const siteUrl =
          a.target === 'sharepoint-connector'
            ? normalizeSharePointSiteUrl(siteUrlRaw)
            : siteUrlRaw;
        const key = `${a.target}::${siteUrl}`;
        if (!bySite.has(key)) bySite.set(key, { siteUrl, kind: a.target, agentNames: new Set(), agentIds: new Set() });
        bySite.get(key)!.agentNames.add(name);
        if (id) bySite.get(key)!.agentIds.add(id);
      }
    }

    const connectors: ConnectorNeeded[] = [...bySite.values()].map((c) => ({
      siteUrl: c.siteUrl,
      kind: c.kind,
      agentNames: [...c.agentNames],
      agentIds: [...c.agentIds],
    }));
    res.json({ connectors });
  } catch (err) {
    res.status(502).json({ error: 'connectors_needed_failed', detail: (err as Error).message });
  }
});

/**
 * GET /api/explore/custom-connectors?session=…&env=…
 *
 * The customer's OWN connectors — the ones no registry can ever list, because they were
 * built in their tenant. Surfaced BEFORE a migration so a connector is never discovered
 * mid-run: the one in the test tenant was published the same day as the agent using it,
 * so no shipped table could have known about it.
 *
 * `listed: false` means we could not read the listing, which is NOT the same as "you have
 * none" and must not be rendered as such.
 */
exploreRouter.get('/custom-connectors', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!session.tenantId) return void res.status(400).json({ error: 'ms_not_connected' });

  const envUrl = String(req.query.env ?? '');
  if (!envUrl) return void res.status(400).json({ error: 'env_required' });
  const envId = session.environments?.find(
    (e) => e.url.replace(/\/$/, '') === envUrl.replace(/\/$/, ''),
  )?.id;
  // Custom connectors are per environment; without the id we would be reporting some
  // other environment's connectors, which is worse than reporting none.
  if (!envId) return void res.status(400).json({ error: 'unknown_environment' });

  const connectors = await listCustomConnectors(session.tenantId, envId);
  res.json({ listed: connectors !== undefined, connectors: connectors ?? [] });
});

/**
 * POST /api/explore/elt/sweep   body: { session }
 *
 * Manual refresh of the connect-time ELT sweep. The sweep itself fires automatically once
 * both clouds connect (routes/auth.ts); this exists because agents created after that
 * moment would otherwise never be seen.
 *
 * Returns as soon as the sweep is UNDERWAY, not when it finishes — a tenant-wide read can
 * take minutes and holding the request open would just time out behind nginx. Poll
 * `GET /elt/status` for the outcome.
 */
exploreRouter.post('/elt/sweep', async (req, res) => {
  const session = await getSession(String(req.body?.session ?? ''));
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!session.tenantId) return void res.status(400).json({ error: 'microsoft_not_connected' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;

  const tenantId = session.tenantId;
  if (sweepInFlight(appUserId, tenantId)) {
    return void res.json({
      started: false,
      alreadyRunning: true,
      last: await lastSweep(appUserId, tenantId),
    });
  }
  // Not awaited: see the doc comment. `runEltSweep` de-duplicates per tenant, and its own
  // rejection is handled here so a background failure cannot take the process down.
  void runEltSweep(appUserId, tenantId).catch((e) => {
    logger.warn(`elt sweep (manual) failed: ${(e as Error).message}`);
  });
  res.json({ started: true, alreadyRunning: false, last: await lastSweep(appUserId, tenantId) });
});

/**
 * GET /api/explore/elt/status?session=
 *
 * What the last sweep did, and whether one is running now. `held` is deliberately included
 * even when no sweep has run this process: these are unredacted customer payloads, and how
 * many are held must be answerable without having to trigger anything.
 */
exploreRouter.get('/elt/status', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  // Status is per connected tenant: the same operator may have several, and answering with
  // whichever swept last would report another customer's run as this one's.
  const tenantId = session.tenantId;
  res.json({
    running: tenantId ? sweepInFlight(appUserId, tenantId) : false,
    last: tenantId ? await lastSweep(appUserId, tenantId) : null,
    retentionDays: rawRetentionDays(),
    held: await rawAgentStats(appUserId, tenantId),
  });
});

/**
 * POST /api/explore/elt/purge   body: { session, confirm: 'delete' }
 *
 * Delete every landed payload for this tenant. This is the deletion guarantee when the TTL
 * is off (`RAW_RETENTION_DAYS=0`), and it is what should be run at the end of an engagement.
 *
 * Admin-only and explicitly confirmed, because it is irreversible and destroys the source
 * the transform reads from — purging mid-engagement means re-reading the customer's tenant
 * from scratch. The confirm field is not ceremony: a purge reachable by a single mistyped
 * URL is one outage away from being an accident.
 *
 * Note for whoever runs it: decommissioning the server is NOT equivalent. Mongo's data sits
 * in the named `csge-mongo-data` volume and survives `docker compose down` without `-v`.
 */
exploreRouter.post('/elt/purge', requireAdmin, async (req, res) => {
  const session = await getSession(String(req.body?.session ?? ''));
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (req.body?.confirm !== 'delete') {
    return void res.status(400).json({ error: 'confirm_required', detail: "send confirm: 'delete'" });
  }
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  // Scoped to the CONNECTED tenant, not the operator. One operator can have several customers
  // connected, and a purge that deleted by operator would take a customer's data as
  // collateral for a purge someone ran against a different customer entirely.
  const tenantId = session.tenantId;
  try {
    const before = await rawAgentStats(appUserId, tenantId);
    // Raw AND everything derived from it. The parsed IR holds the same customer content —
    // instructions, topics, knowledge sources — so deleting only the payloads would report a
    // deletion that had not happened. Sequential, not Promise.all: if the second throws, the
    // response must not claim the first succeeded as part of a completed purge.
    const raw = await purgeRawAgents(appUserId, tenantId);
    const ir = await purgeCachedIR(appUserId, tenantId);
    const sweeps = await purgeSweepResults(appUserId, tenantId);
    // The user snapshot is customer directory data too — leaving it behind would make the
    // purge report a deletion it had not fully performed.
    const users = await purgeSourceUsers(appUserId, tenantId);
    // Rows written before these collections recorded a tenant. They are NOT deleted by a
    // tenant-scoped purge, because they could belong to any customer this operator connected.
    // Surfaced rather than swallowed: a purge that quietly left customer data behind while
    // reporting success is the failure this whole endpoint exists to avoid.
    const untagged = raw.untagged + ir.untagged + sweeps.untagged + users.untagged;
    logger.warn(
      `elt purge: ${raw.deleted} raw payload(s), ${ir.deleted} cached IR, ` +
        `${sweeps.deleted} sweep record(s), ${users.deleted} user snapshot(s) deleted for ` +
        `${appUserId}/${tenantId ?? 'all tenants'}` +
        (untagged ? ` — ${untagged} untagged row(s) left in place` : ''),
    );
    res.json({
      deleted: raw.deleted + ir.deleted + sweeps.deleted + users.deleted,
      rawDeleted: raw.deleted,
      irDeleted: ir.deleted,
      sweepsDeleted: sweeps.deleted,
      usersDeleted: users.deleted,
      untagged,
      scope: tenantId ? 'tenant' : 'all-tenants',
      heldBefore: before.total,
    });
  } catch (e) {
    // Unlike the rest of this collection's helpers, a failed purge must NOT read as success:
    // reporting a deletion that did not happen is the worst possible answer here.
    res.status(500).json({ error: 'purge_failed', detail: (e as Error).message });
  }
});
