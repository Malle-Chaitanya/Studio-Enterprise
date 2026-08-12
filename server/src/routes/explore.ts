import { Router } from 'express';
import { clientCredsToken } from '../auth/microsoft.js';
import { logger } from '../logger.js';
import { extractAgent, inventory, listBots } from '../services/dataverse.js';
import { normalizeSharePointSiteUrl } from '../services/knowledgePlanner.js';
import { assessAgent } from '../services/assess.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { getSession, DEFAULT_APP_USER_ID } from '../sessionStore.js';
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
    const token = await clientCredsToken(session.tenantId ?? '', env);
    const ir = await extractAgent(env, token, { botid: botId, name });

    if ((req.query.format as string) === 'json') {
      res
        .type('application/json')
        .set('Content-Disposition', `attachment; filename="${name.replace(/[^a-z0-9]+/gi, '_')}.ir.json"`)
        .send(JSON.stringify(ir, null, 2));
      return;
    }

    res.json({ assessment: assessAgent(ir) });
  } catch (err) {
    res.status(502).json({ error: 'assessment_failed', detail: (err as Error).message });
  }
});

export interface ConnectorNeeded {
  siteUrl: string;
  kind: 'sharepoint-connector' | 'onedrive-connector';
  agentNames: string[];
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
        return { name: bot.name, actions: assessAgent(ir).knowledge?.actions ?? [] };
      } catch (err) {
        logger.debug({ err, bot: bot.name }, 'connectors-needed: agent extract failed');
        return { name: bot.name, actions: [] };
      }
    });

    const bySite = new Map<string, { siteUrl: string; kind: ConnectorNeeded['kind']; agentNames: Set<string> }>();
    for (const { name, actions } of perAgent) {
      for (const a of actions) {
        if (a.target !== 'sharepoint-connector' && a.target !== 'onedrive-connector') continue;
        const siteUrlRaw = a.references?.[0];
        if (!siteUrlRaw) continue;
        const siteUrl =
          a.target === 'sharepoint-connector'
            ? normalizeSharePointSiteUrl(siteUrlRaw)
            : siteUrlRaw;
        const key = `${a.target}::${siteUrl}`;
        if (!bySite.has(key)) bySite.set(key, { siteUrl, kind: a.target, agentNames: new Set() });
        bySite.get(key)!.agentNames.add(name);
      }
    }

    const connectors: ConnectorNeeded[] = [...bySite.values()].map((c) => ({
      siteUrl: c.siteUrl,
      kind: c.kind,
      agentNames: [...c.agentNames],
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
