import { Router } from 'express';
import { clientCredsToken } from '../auth/microsoft.js';
import { logger } from '../logger.js';
import { extractAgent, inventory, listBots } from '../services/dataverse.js';
import { assessAgent } from '../services/assess.js';
import { buildOrganizationProfile } from '../services/organizationProfile.js';
import { getSession, DEFAULT_APP_USER_ID } from '../sessionStore.js';
import {
  cacheEnvironments,
  getCachedEnvironments,
  type EnvInfo,
} from '../db/repos/environments.js';

export const exploreRouter = Router();

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
        return base;
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
    const profile = await buildOrganizationProfile(session, new Date().toISOString());
    const ir = await extractAgent(env, token, { botid: botId, name }, { ownerDomains: profile.ownedDomains });

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
