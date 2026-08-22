import { Router } from 'express';
import { runMigration } from '../orchestrator.js';
import { renderReportExcel } from '../services/report.js';
import { resolveScope } from '../services/scope.js';
import { getSession, updateSession, credentialScope, DEFAULT_APP_USER_ID } from '../sessionStore.js';
import {
  upsertConnectorCredential,
  listConnectorCredentials,
  getConnectorCredential,
  deleteConnectorCredential,
} from '../db/repos/connectorCredentials.js';
import { clientCredsToken } from '../auth/microsoft.js';
import { resolveSystemUserEmail } from '../services/dataverse.js';
import { getSaToken } from '../auth/google.js';
import { defaultDestination, effectiveGeminiProject } from '../services/gemini.js';
import { findCandidates } from '../services/graphSearch.js';
import { resolveShareUrlSmart } from '../services/graphFiles.js';
import { migrateSharePointDriveItem } from '../services/knowledgeDataStoreExecutor.js';
import { detectThirdPartyConnectors } from '../services/thirdPartyConnectorScan.js';
import { detectKnowledgeConnectors } from '../services/knowledgeConnectorScan.js';
import { listBots } from '../services/dataverse.js';
import { upsertSecretIfChanged, preflightSecretAccess, deleteSecret, getSecretOwnership, getEntraSecret } from '../services/secretManager.js';
import { validateConnectorCredentials } from '../services/connectorValidator.js';
import { logger } from '../logger.js';
import { serviceAccountEmail } from '../auth/google.js';
import {
  connectorSecretId,
  connectorCredentialFields,
  connectorCredentialScope,
  connectorsSharingCredentials,
} from '../services/connectorCredentials.js';
import { impersonationAllowed, getWorkspaceDomainsAsAdmin } from '../auth/google.js';
import { REGISTRY_BY_ID, CREDENTIAL_GROUPS } from '../connectors/registry.js';
import { resolveOpIndex } from '../connectors/captureOpIndex.js';
import { MS_APP_REG_FIELDS } from '../services/connectorToolBuilder.js';
import {
  getAgentConnectorIdentity,
  upsertAgentConnectorIdentity,
} from '../db/repos/agentConnectorIdentity.js';
import {
  listAgentSurfaceChoices,
  saveAgentSurfaceChoice,
  SURFACE_EQUIVALENTS,
} from '../db/repos/agentSurfaceChoice.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import { agentConnectorIds } from '../services/connectorToolBuilder.js';
import { suggestEnvironmentDriveIdentity } from '../services/driveIdentityResolution.js';
import { buildOrganizationProfile } from '../services/organizationProfile.js';
import { getIdentityMap } from '../db/repos/identityMap.js';
import { listRuns, getRunResults } from '../db/repos/migrations.js';
import type { DestinationOptions, GeminiDestination, MigrationResult, MigrationScope } from '../types.js';

export const migrateRouter = Router();

/**
 * Resolve a migration scope into a concrete plan, store it on the session, and
 * return a preview (what will migrate + destination naming). Call before /stream.
 */
migrateRouter.post('/plan', async (req, res) => {
  const { session: sessionId, scope, destination, dryRun, forceRedeploy, acknowledgeAclLoss } = req.body as {
    session?: string;
    scope?: MigrationScope;
    destination?: DestinationOptions;
    dryRun?: boolean;
    /** Redeploy already-migrated agents even when their source is unchanged. */
    forceRedeploy?: boolean;
    /** Customer accepted that indexed knowledge loses its source permissions. */
    acknowledgeAclLoss?: boolean;
  };
  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!scope) return void res.status(400).json({ error: 'scope_required' });

  // A destination that is missing its engine used to be discovered at the END of a
  // deploy: the Reasoning Engine was built and billed, registration 404'd with
  // `Engine "undefined" does not exist`, and the orphan was left running. Nothing about
  // that failure needed six minutes and a GPU to establish.
  const badEnv = Object.entries(destination?.environmentMap ?? {}).find(
    ([, d]) => !d || typeof d.project !== 'string' || !d.project.trim() || typeof d.engine !== 'string' || !d.engine.trim(),
  );
  if (badEnv) {
    return void res.status(400).json({
      error: 'invalid_destination',
      detail:
        `The destination for ${badEnv[0]} is missing its project or Gemini app. ` +
        'Pick both on the Select & Map Environments step before migrating.',
    });
  }

  try {
    const dest = destination ?? {};
    const plan = await resolveScope(session, scope, dest);
    plan.dryRun = !!dryRun;
    plan.forceRedeploy = !!forceRedeploy;
    plan.acknowledgeAclLoss = !!acknowledgeAclLoss;
    // Seed from the durable per-customer record (connectorCredentials.ts), not just
    // whatever got saved in THIS session — otherwise a customer who already configured
    // Confluence/Jira/Dynamics in an earlier session (and sees "✓ Saved" in the UI) gets
    // silently skipped here, because the orchestrator only ever reads plan.savedConnectors,
    // which starts empty on every new plan. Confirmed live 2026-08-07: a Confluence source
    // classified correctly but never crawled because this exact gap left savedConnectors
    // empty despite the Atlassian credential already sitting in Secret Manager.
    const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
    const durablySaved = await listConnectorCredentials(appUserId).catch(() => []);
    if (durablySaved.length) {
      plan.savedConnectors = [...new Set([...(plan.savedConnectors ?? []), ...durablySaved.map((c) => c.connectorId)])];
    }
    await updateSession(sessionId!, { plan });
    res.json({
      totalAgents: plan.totalAgents,
      environments: plan.units.map((u) => ({ name: u.envName, agents: u.bots.map((b) => b.name) })),
      destination: plan.destination,
      dryRun: plan.dryRun,
      forceRedeploy: plan.forceRedeploy,
      acknowledgeAclLoss: plan.acknowledgeAclLoss,
    });
  } catch (err) {
    res.status(500).json({ error: 'plan_failed', detail: (err as Error).message });
  }
});

/** SSE stream that runs the session's stored plan and emits progress events. */
migrateRouter.get('/stream', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) {
    res.status(404).json({ error: 'session_not_found' });
    return;
  }
  if (!session.plan) {
    res.status(400).json({ error: 'no_plan' });
    return;
  }

  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();

  const send = (data: unknown) => res.write(`data: ${JSON.stringify(data)}\n\n`);
  let closed = false;
  req.on('close', () => {
    closed = true;
  });

  try {
    for await (const evt of runMigration(session, session.plan)) {
      if (closed) break;
      send(evt);
    }
  } catch (err) {
    send({ type: 'log', level: 'fail', msg: `Fatal: ${(err as Error).message}` });
    send({ type: 'done', summary: 'Migration failed unexpectedly.', results: [] });
  } finally {
    res.end();
  }
});

/** Render an Excel (.xlsx) report from client-held results (for download). */
migrateRouter.post('/report', async (req, res) => {
  const { orgName, results } = req.body as { orgName?: string; results?: MigrationResult[] };
  if (!Array.isArray(results)) {
    res.status(400).json({ error: 'results_required' });
    return;
  }
  const buf = await renderReportExcel(orgName ?? 'Organization', results);
  res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="migration-report.xlsx"');
  res.send(buf);
});

/**
 * POST /api/migrate/knowledge-candidates
 * body: { session, envUrl, filename, modifiedByUserId?, sharePointSiteIds?: string[] }
 *
 * Search-and-confirm for SharePoint/OneDrive "upload and sync" knowledge
 * sources whose real target Copilot Studio hides behind an opaque
 * reference (see .claude/memory/decisions.md). Searches a deliberately
 * NARROW scope — the specific person who added the source (OneDrive) and/or
 * a caller-supplied, bounded list of SharePoint sites — never a tenant-wide
 * sweep. Returns CANDIDATES only; nothing is migrated until the customer
 * confirms one via /knowledge-source-confirm.
 */
migrateRouter.post('/knowledge-candidates', async (req, res) => {
  const body = req.body as {
    session?: string;
    envUrl?: string;
    filename?: string;
    modifiedByUserId?: string;
    sharePointSiteIds?: string[];
  };
  const session = await getSession(body.session);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!body.filename) return void res.status(400).json({ error: 'filename_required' });
  if (!session.tenantId) return void res.status(400).json({ error: 'session_missing_tenant' });

  try {
    const graphToken = await clientCredsToken(session.tenantId, 'https://graph.microsoft.com');

    let oneDriveOwnerEmail: string | undefined;
    if (body.modifiedByUserId && body.envUrl) {
      const dvToken = await clientCredsToken(session.tenantId, body.envUrl);
      oneDriveOwnerEmail = (await resolveSystemUserEmail(body.envUrl, dvToken, body.modifiedByUserId)) ?? undefined;
    }

    const candidates = await findCandidates(graphToken, body.filename, {
      oneDriveOwnerEmail,
      sharePointSiteIds: body.sharePointSiteIds,
    });
    res.json({ candidates, scopedToUser: oneDriveOwnerEmail ?? null });
  } catch (err) {
    res.status(502).json({ error: 'knowledge_candidates_failed', detail: (err as Error).message });
  }
});

/**
 * POST /api/migrate/knowledge-source-resolve-url
 * body: { session, url }
 *
 * Alternative to filename search for a "FederatedStructuredSearchSource"
 * knowledge source: a person opens the source in Copilot Studio's own
 * Knowledge editor, copies its "Knowledge URL" field (Copilot Studio resolves
 * this internally — there is no public API for it, see
 * .claude/memory/decisions.md), and pastes it here instead of reviewing a
 * filename-search candidate list. This is a STRONGER signal than a filename
 * search: it's Copilot Studio's own resolved answer, not a keyword guess.
 *
 * The URL sometimes points at a FOLDER rather than a file directly (confirmed
 * live) — handled by resolveShareUrlSmart: a folder with exactly one file is
 * as confident as a direct file link; a folder with several files still needs
 * a person to pick one from `candidates`, same as the search-candidate flow.
 */
migrateRouter.post('/knowledge-source-resolve-url', async (req, res) => {
  const body = req.body as { session?: string; url?: string };
  const session = await getSession(body.session);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!body.url) return void res.status(400).json({ error: 'url_required' });
  if (!session.tenantId) return void res.status(400).json({ error: 'session_missing_tenant' });

  try {
    const graphToken = await clientCredsToken(session.tenantId, 'https://graph.microsoft.com');
    const resolution = await resolveShareUrlSmart(graphToken, body.url);
    res.json(resolution);
  } catch (err) {
    res.status(502).json({ error: 'knowledge_source_resolve_url_failed', detail: (err as Error).message });
  }
});

/**
 * POST /api/migrate/knowledge-source-confirm
 * body: { session, agentId, driveId, itemId, name, dryRun?, project?, engine?, assistant? }
 *
 * The customer has confirmed which search candidate (or manually-supplied
 * drive item) is the real source — this fetches it via Graph and attaches it
 * to the migrated agent's knowledge, same pipeline regardless of how the
 * item was identified. Attaches directly onto the agent (same mechanism as
 * plain local uploads) — no GCS bucket required.
 *
 * dryRun=true runs everything (idempotency check, Graph resolve, byte
 * download) but stops before the Gemini upload/attach — proves the pipeline
 * works without writing to a live agent.
 */
migrateRouter.post('/knowledge-source-confirm', async (req, res) => {
  const body = req.body as {
    session?: string;
    agentId?: string;
    driveId?: string;
    itemId?: string;
    name?: string;
    dryRun?: boolean;
    project?: string;
    engine?: string;
    assistant?: string;
  };
  const session = await getSession(body.session);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!body.agentId || !body.driveId || !body.itemId || !body.name) {
    return void res.status(400).json({ error: 'agent_id_drive_id_item_id_and_name_required' });
  }
  if (!session.tenantId) return void res.status(400).json({ error: 'session_missing_tenant' });

  const project = body.project || session.geminiProject || '';
  if (!project) return void res.status(400).json({ error: 'project_required' });
  const dest: GeminiDestination = body.engine
    ? { project, engine: body.engine, assistant: body.assistant || 'default_assistant' }
    : defaultDestination(project);

  try {
    const [saToken, graphToken] = await Promise.all([
      getSaToken(session.gEmail),
      clientCredsToken(session.tenantId, 'https://graph.microsoft.com'),
    ]);
    const result = await migrateSharePointDriveItem(
      dest,
      saToken,
      graphToken,
      body.agentId,
      { driveId: body.driveId, itemId: body.itemId, name: body.name },
      body.dryRun === true,
    );
    if (result.error) {
      return void res.status(502).json({ error: 'knowledge_source_confirm_failed', detail: result.error, ...result });
    }
    res.json(result);
  } catch (err) {
    res.status(502).json({ error: 'knowledge_source_confirm_failed', detail: (err as Error).message });
  }
});

// ── Third-party connector detection + credential storage ──────────────────────

/**
 * GET /api/migrate/third-party-connectors?session=&envUrl=
 *
 * envUrl is REQUIRED and must be one of the environments the user actually
 * selected agents from (SelectData) — NOT session.dvOrgUrl. A tenant can have
 * agents spread across several Dataverse environments; dvOrgUrl is only ever
 * "whichever environment happened to be probed first at Microsoft connect
 * time" (see routes/auth.ts), so scanning just that one silently misses PA
 * flows that live in every other environment. The caller (ConnectorConfig)
 * loops this once per selected environment, same pattern already used for
 * /knowledge-connectors below.
 */
migrateRouter.get('/third-party-connectors', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!session.tenantId) return void res.status(400).json({ error: 'ms_not_connected' });
  const envUrl = req.query.envUrl as string | undefined;
  if (!envUrl) return void res.status(400).json({ error: 'env_url_required' });

  try {
    const dvToken = await clientCredsToken(session.tenantId, envUrl);
    const connectors = await detectThirdPartyConnectors(envUrl, dvToken);
    res.json({ connectors });
  } catch (err) {
    res.status(502).json({ error: 'connector_scan_failed', detail: (err as Error).message });
  }
});

/**
 * GET /api/migrate/drive-identities?session=&envUrl=&sourceIds=id1,id2
 *
 * For each Drive-connected agent, which Google account it should impersonate — a
 * confirmed one already saved, and/or a best-effort suggestion. Never returns a
 * "confirmed" status on its own initiative; only routes/migrate.ts's POST below,
 * driven by an admin action, does that. See db/repos/agentConnectorIdentity.ts.
 */
migrateRouter.get('/drive-identities', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!session.tenantId) return void res.status(400).json({ error: 'ms_not_connected' });
  const envUrl = req.query.envUrl as string | undefined;
  if (!envUrl) return void res.status(400).json({ error: 'env_url_required' });
  const sourceIds = String(req.query.sourceIds ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (sourceIds.length === 0) return void res.json({ identities: [] });

  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  try {
    const currentByAgent = new Map(
      await Promise.all(
        sourceIds.map(async (sourceId) => [sourceId, await getAgentConnectorIdentity(appUserId, sourceId, 'shared_googledrive')] as const),
      ),
    );

    // Best-effort suggestion, computed once for the whole environment — only worth
    // the Dataverse round-trips if at least one agent here still needs one.
    let suggestion: { email: string; reason: string } | null = null;
    if ([...currentByAgent.values()].some((c) => !c || c.status !== 'confirmed')) {
      try {
        const dvToken = await clientCredsToken(session.tenantId, envUrl);
        const [profile, overrides] = await Promise.all([
          buildOrganizationProfile(session, new Date().toISOString()),
          getIdentityMap(appUserId, session.tenantId),
        ]);
        suggestion = await suggestEnvironmentDriveIdentity(envUrl, dvToken, profile.ownedDomains, overrides);
      } catch (err) {
        logger.warn({ err }, 'drive-identities: suggestion lookup failed — continuing without one');
      }
    }

    const identities = sourceIds.map((sourceId) => {
      const current = currentByAgent.get(sourceId) ?? null;
      return {
        sourceId,
        current: current ? { email: current.impersonateEmail, status: current.status, reason: current.suggestionReason } : null,
        suggestion: current?.status === 'confirmed' ? null : suggestion,
      };
    });
    res.json({ identities });
  } catch (err) {
    res.status(502).json({ error: 'drive_identity_lookup_failed', detail: (err as Error).message });
  }
});

/**
 * POST /api/migrate/drive-identities
 * body: { session, sourceId, email }
 *
 * Admin confirms (or corrects) which Google account ONE agent's Drive connector
 * should impersonate. Same domain-ownership check as the shared connector
 * credential save — an admin can only assign identities within their own,
 * OAuth-proven Google Workspace, never another CloudFuze customer's.
 */
migrateRouter.post('/drive-identities', async (req, res) => {
  const { session: sessionId, sourceId, email } = req.body as { session?: string; sourceId?: string; email?: string };
  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!sourceId || !email?.trim()) {
    return void res.status(400).json({ error: 'source_id_and_email_required' });
  }
  const target = email.trim();
  const ownDomain = session.gEmail?.split('@')[1]?.toLowerCase();
  if (!ownDomain) {
    return void res.status(400).json({
      error: 'impersonation_domain_mismatch',
      detail: 'Could not verify your Google Workspace domain — reconnect Google and try again.',
    });
  }
  const verifiedDomains = await getWorkspaceDomainsAsAdmin(session.gEmail!);
  const allowedDomains = verifiedDomains.length ? verifiedDomains : [ownDomain];
  if (!impersonationAllowed(target, allowedDomains)) {
    return void res.status(400).json({
      error: 'impersonation_domain_mismatch',
      detail: `"${target}" is not in your Google Workspace (verified domains: ${allowedDomains.join(', ')}). An agent can only be set up to access Drive for users in your own organization.`,
    });
  }

  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  await upsertAgentConnectorIdentity(appUserId, sourceId, 'shared_googledrive', {
    impersonateEmail: target,
    status: 'confirmed',
  });
  res.json({ ok: true });
});

/**
 * GET /api/migrate/surface-equivalence?session=&sourceIds=id1,id2
 *
 * For each agent that uses a Microsoft surface with a Google equivalent (today: Outlook ->
 * Gmail), what the customer is being asked to accept and what they have decided so far.
 *
 * Every other connector is same-vendor and needs no decision. This one is a CHOICE: the
 * source agent read a Microsoft mailbox, and whether it should now read a Google one is the
 * customer's call. An absent decision is UNDECIDED and wires nothing — silence must never
 * read as consent for a mailbox. See db/repos/agentSurfaceChoice.ts.
 */
/**
 * GET /api/migrate/selection?session=<id>
 *
 * Which agents the customer selected, per environment — read from the SERVER-side plan.
 *
 * The Connectors screen previously read this from `sessionStorage` only. sessionStorage is
 * per browser TAB and empty after a restart, a new tab, or resuming a session from a URL, so
 * the screen silently believed no agents were selected and rendered none of the per-agent
 * sections — including the Outlook/Teams choice. Nothing errored; the choice simply was not
 * there, which is the worst way for a decision screen to fail.
 *
 * The plan is authoritative and survives all of that, so it is the fallback.
 */
migrateRouter.get('/selection', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const units = session.plan?.units ?? [];
  res.json({
    selection: units.map((u) => ({
      env: u.envUrl,
      envName: u.envName,
      botIds: (u.bots ?? []).map((b) => b.botid),
    })),
  });
});

migrateRouter.get('/surface-equivalence', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const sourceIds = String(req.query.sourceIds ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (sourceIds.length === 0) return void res.json({ surfaces: [] });

  const envUrl = req.query.envUrl as string | undefined;
  if (!envUrl) return void res.status(400).json({ error: 'env_url_required' });

  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  try {
    const choices = await listAgentSurfaceChoices(appUserId, sourceIds);
    const byAgent = new Map(choices.map((c) => [`${c.sourceId}:${c.sourceConnectorId}`, c]));

    // Read the cached IR rather than the staged row: `agentConnectorIds` is the one place
    // that knows which connectors an agent really uses, including the ones inferred from
    // knowledge sources rather than declared as tools.
    const cached = await Promise.all(
      sourceIds.map(async (sourceId) => [sourceId, await getCachedIR(appUserId, envUrl, sourceId)] as const),
    );

    // Only agents that ACTUALLY use the Microsoft surface are asked. Offering the choice on
    // an agent with no mail connector is noise the customer has to read and dismiss.
    const surfaces = [];
    for (const [sourceId, entry] of cached) {
      if (!entry) continue;
      const connectorIds = agentConnectorIds(entry.ir);
      for (const [sourceConnectorId, eq] of Object.entries(SURFACE_EQUIVALENTS)) {
        if (!connectorIds.has(sourceConnectorId)) continue;
        const decided = byAgent.get(`${sourceId}:${sourceConnectorId}`);
        surfaces.push({
          sourceId,
          agentName: entry.ir.name,
          sourceConnectorId,
          sourceName: eq.sourceName,
          noun: eq.noun,
          targets: eq.targets,
          decision: decided?.decision ?? null,
          impersonateEmail: decided?.impersonateEmail ?? null,
        });
      }
    }
    // Logged because this screen fails SILENTLY when it fails: a missing row looks exactly
    // like "no agent uses that service", and the agent then deploys with no tools for it.
    // The ids the client asked about are the one thing not visible from the server otherwise.
    logger.info(
      `surface-equivalence: asked about ${sourceIds.length} agent(s) [${sourceIds.join(', ')}], ` +
        `offering ${surfaces.length} choice(s) [${surfaces.map((s) => `${s.agentName}:${s.sourceConnectorId}`).join(', ') || 'none'}]`,
    );
    res.json({ surfaces });
  } catch (err) {
    res.status(502).json({ error: 'surface_equivalence_failed', detail: (err as Error).message });
  }
});

/**
 * POST /api/migrate/surface-equivalence
 * body: { session, sourceId, sourceConnectorId, decision: 'migrate'|'skip', email? }
 *
 * Record one agent's decision. `email` names the mailbox that agent reads.
 *
 * Same domain-ownership check as the Drive identity save, and for a stronger reason: this
 * grants an agent read/write access to a person's MAIL. An admin may only target a mailbox
 * inside their own OAuth-proven Workspace.
 */
migrateRouter.post('/surface-equivalence', async (req, res) => {
  const { session: sessionId, sourceId, sourceConnectorId, decision, email } = req.body as {
    session?: string; sourceId?: string; sourceConnectorId?: string;
    decision?: string; email?: string;
  };
  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!sourceId || !sourceConnectorId) {
    return void res.status(400).json({ error: 'source_id_and_connector_required' });
  }
  const equivalent = SURFACE_EQUIVALENTS[sourceConnectorId];
  if (!equivalent) return void res.status(400).json({ error: 'unknown_surface' });

  // `decision` is either 'skip' or the connector id of a target THIS surface offers.
  // Anything else is rejected rather than stored: an unrecognised value would later resolve
  // to "undecided" and silently give the agent no mail tools at all.
  const chosen = equivalent.targets.find((t) => t.connectorId === decision);
  if (decision !== 'skip' && !chosen) {
    return void res.status(400).json({
      error: 'unknown_target',
      detail: `Choose one of: ${equivalent.targets.map((t) => t.connectorId).join(', ')}, or "skip".`,
    });
  }

  const target = email?.trim();
  if (chosen) {
    if (!target) {
      return void res.status(400).json({
        error: 'email_required',
        detail: `Naming the mailbox this agent should use is required — an agent cannot read mail without one.`,
      });
    }
    // Domain ownership is checked for the GOOGLE target only. The Microsoft target reaches
    // mail through the customer's OWN Entra app registration, whose application permissions
    // are already scoped to their tenant by Microsoft — there is no cross-tenant reach to
    // guard against, and their Google domain says nothing about which Microsoft mailboxes
    // they own.
    if (chosen.connectorId === 'shared_gmail') {
      const ownDomain = session.gEmail?.split('@')[1]?.toLowerCase();
      if (!ownDomain) {
        return void res.status(400).json({
          error: 'impersonation_domain_mismatch',
          detail: 'Could not verify your Google Workspace domain — reconnect Google and try again.',
        });
      }
      const verifiedDomains = await getWorkspaceDomainsAsAdmin(session.gEmail!);
      const allowedDomains = verifiedDomains.length ? verifiedDomains : [ownDomain];
      if (!impersonationAllowed(target, allowedDomains)) {
        return void res.status(400).json({
          error: 'impersonation_domain_mismatch',
          detail: `"${target}" is not in your Google Workspace (verified domains: ${allowedDomains.join(', ')}). An agent can only be given access to a mailbox in your own organization.`,
        });
      }
    }
  }

  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  await saveAgentSurfaceChoice({
    appUserId,
    sourceId,
    sourceConnectorId,
    decision: decision!,
    targetConnectorId: chosen?.connectorId,
    impersonateEmail: chosen ? target : undefined,
    decidedBy: session.gEmail,
  });
  res.json({ ok: true, decision });
});

/**
 * POST /api/migrate/knowledge-connectors
 * body: { session, envUrl, botIds: string[] }
 *
 * Scans Dataverse knowledge-source botcomponents for the specified agents and
 * returns which knowledge connectors need credentials (e.g. shared_confluence).
 * Called from ConnectorConfig after the user has selected agents.
 */
migrateRouter.post('/knowledge-connectors', async (req, res) => {
  const { session: sessionId, envUrl, botIds } = req.body as {
    session?: string;
    envUrl?: string;
    botIds?: string[];
  };
  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!session.tenantId) return void res.status(400).json({ error: 'ms_not_connected' });
  if (!envUrl || !Array.isArray(botIds) || botIds.length === 0) {
    return void res.json({ connectors: [] });
  }

  try {
    const dvToken = await clientCredsToken(session.tenantId, envUrl);
    // Resolve agent names so the UI can say WHICH agent needs each connector — a flat
    // list gives no way to tell whether a connector belongs to the agent you selected.
    let botNames: Map<string, string> | undefined;
    try {
      const bots = await listBots(envUrl, dvToken);
      botNames = new Map(bots.map((b) => [b.botid, b.name]));
    } catch {
      /* attribution is a nicety; detection still works without it */
    }
    // Answer readiness from the CUSTOMER'S own connector definitions where we can reach
    // them, not from a capture of ours. Their environment decides which connectors exist
    // and at what version; a fixture is only a fallback. The environment GUID differs from
    // the org URL, so resolve it from the session's discovered environments.
    const envId = session.environments?.find(
      (e) => e.url.replace(/\/$/, '') === envUrl.replace(/\/$/, ''),
    )?.id;
    const captureCtx = envId
      ? { tenantId: session.tenantId, environmentId: envId, scope: credentialScope(session) }
      : undefined;
    const connectors = await detectKnowledgeConnectors(envUrl, dvToken, botIds, botNames, captureCtx);
    res.json({ connectors });
  } catch (err) {
    res.status(502).json({ error: 'knowledge_connector_scan_failed', detail: (err as Error).message });
  }
});

/**
 * POST /api/migrate/third-party-connectors/credentials
 * body: { session, connectorId, creds: [{ field, value }] }
 * Stores credentials in Secret Manager and records connectorId on the session plan.
 */
migrateRouter.post('/third-party-connectors/credentials', async (req, res) => {
  const { session: sessionId, connectorId, creds } = req.body as {
    session?: string;
    connectorId?: string;
    creds?: Array<{ field: string; value: string }>;
  };
  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  // An EMPTY creds array is legitimate: the client sends only fields the admin typed,
  // and a connector whose credentials all came from a sibling in the same group (Jira
  // after Confluence, Teams after SharePoint) has nothing new to write — it still has
  // to be registered, or the migration will not wire a tool for it. Rejected below if
  // no existing secret turns out to back it.
  if (!connectorId || !Array.isArray(creds)) {
    return void res.status(400).json({ error: 'connector_id_and_creds_required' });
  }
  if (!session.geminiProject) return void res.status(400).json({ error: 'google_not_connected' });

  // The Drive connector's `impersonate_email` becomes a DWD impersonation target
  // INSIDE the deployed container (adk_deploy.py's `_mint_token` → `.with_subject()`),
  // using CloudFuze's own shared SA. That SA holds domain-wide delegation across every
  // customer who has granted it — so an unchecked target here would let this
  // customer's admin type a user from a DIFFERENT CloudFuze customer's domain and have
  // the deployed agent read that other customer's Drive. Same invariant auth/google.ts
  // already enforces for getSaToken(): only ever impersonate within the caller's own,
  // OAuth-proven domain. Checked here, at save time, rather than left to the container
  // (which has no allowlist of its own and cannot re-derive whose domain is whose).
  if (connectorId === 'shared_googledrive') {
    const target = creds.find((c) => c.field === 'impersonate_email')?.value?.trim();
    if (target) {
      const ownDomain = session.gEmail?.split('@')[1]?.toLowerCase();
      if (!ownDomain) {
        return void res.status(400).json({
          error: 'impersonation_domain_mismatch',
          detail: 'Could not verify your Google Workspace domain — reconnect Google and try again.',
        });
      }
      // One Workspace can have several verified domains under the SAME account (a
      // company that owns both a .com and a .co, say) — comparing only the login
      // email's own domain wrongly blocked a legitimate same-company user on a
      // sibling domain (live case: storefuze.com admin, erik@filefuze.co — both
      // verified under one Workspace, DWD already granted there). Ask Google
      // directly which domains THIS session's own Workspace verified, via a
      // Directory-scoped DWD token for the session's OWN admin (session.gEmail) —
      // never anyone else's. Best-effort: if the customer hasn't also granted the
      // admin.directory.domain.readonly scope, this returns [] and we fall back to
      // the single login-domain check — narrower, but still safe (never widens to
      // "allow everything" on failure).
      const verifiedDomains = await getWorkspaceDomainsAsAdmin(session.gEmail!);
      const allowedDomains = verifiedDomains.length ? verifiedDomains : [ownDomain];
      if (!impersonationAllowed(target, allowedDomains)) {
        return void res.status(400).json({
          error: 'impersonation_domain_mismatch',
          detail: `"${target}" is not in your Google Workspace (verified domains: ${allowedDomains.join(', ')}). The migrated agent can only be set up to access Drive for users in your own organization.`,
        });
      }
    }
  }

  try {
    const saToken = await getSaToken(session.gEmail);
    // Fail BEFORE writing anything, and say what is actually wrong. Discovering this
    // on the write meant a half-saved connector and a UI blaming the Google
    // connection, which was never the problem.
    // Secrets MUST go to the project the agent will be deployed into, or the deployed
    // container cannot read them. Apply the same override resolveDestination uses.
    const secretsProject = effectiveGeminiProject(session.geminiProject);
    const access = await preflightSecretAccess(secretsProject, saToken, serviceAccountEmail());
    if (!access.ok) return void res.status(403).json({ error: access.code, detail: access.detail });

    // Tenant-scoped ids. Without the appUserId two customers sharing one Google
    // project write to the same secret, so the second save overwrites the first and
    // the first customer's deployed agent starts reading the second's credential.
    const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;

    // The client may send only the fields the admin actually changed, so merge onto
    // what is already recorded. Replacing the record wholesale would erase the secret
    // ids of untouched fields, and the deployed agent resolves its credentials from
    // exactly those ids.
    // Look across the whole credential group, not just this connector: one Atlassian
    // token backs Confluence and Jira, one Azure app backs all five Microsoft
    // connectors. A sibling's record is where this connector's shared secret ids live.
    const scope = connectorCredentialScope(connectorId);
    const groupRecords = (await listConnectorCredentials(appUserId)).filter(
      (r) => r.project === secretsProject && connectorCredentialScope(r.connectorId) === scope,
    );
    const priorRecord =
      (await getConnectorCredential(appUserId, connectorId)) ??
      (groupRecords.length ? groupRecords[0] : null);

    if (creds.length === 0 && !priorRecord) {
      return void res.status(400).json({
        error: 'connector_id_and_creds_required',
        detail: 'No credentials were supplied and none are already stored for this connector.',
      });
    }

    const secretIdByField: Record<string, string> = { ...(priorRecord?.secretIds ?? {}) };
    const secretIds: string[] = [];
    for (const { field, value } of creds) {
      // Reuse the id this field was stored under before, so an update lands on the
      // secret the already-deployed agents read rather than creating a parallel one.
      const secretId = priorRecord?.secretIds?.[field] ?? connectorSecretId(connectorId, field, credentialScope(session));
      // Labels are the only way to tell later which tenant and connector a secret
      // belongs to — the id alone cannot be queried, so without these there is no way
      // to enumerate a customer's credentials in order to audit or remove them.
      await upsertSecretIfChanged(saToken, secretsProject, secretId, value, {
        managed_by: 'studio-enterprise',
        // The OWNER scope, not the Mongo key: appUserId is 'default' for every customer
        // until sign-in is wired, which would label every customer's secret identically
        // and make the delete path's ownership check meaningless.
        app_user: credentialScope(session),
        connector: connectorId,
      });
      secretIds.push(secretId);
      secretIdByField[field] = secretId;
    }

    // Durable record, keyed by customer — survives the session TTL so a returning
    // admin sees "already configured" instead of re-entering credentials that are
    // already in Secret Manager. Field names + secret ids only, never values.
    // It is also the authority on where a credential really lives: everything
    // downstream resolves ids from here rather than recomputing them, so credentials
    // saved before tenant scoping keep backing the agents already deployed on them.
    await upsertConnectorCredential(appUserId, {
      connectorId,
      fields: [...new Set([...(priorRecord?.fields ?? []), ...creds.map((c) => c.field)])],
      secretIds: secretIdByField,
      project: secretsProject,
    });

    // Still recorded on the session plan: that's what the in-flight migration reads.
    const existing = session.plan?.savedConnectors ?? [];
    if (!existing.includes(connectorId)) {
      const updated = { ...session.plan, savedConnectors: [...existing, connectorId] };
      await updateSession(sessionId!, { plan: updated as typeof session.plan });
    }

    // Prove the credentials work before telling the admin they are saved.
    //
    // Validated AFTER the write, against the full merged set read back from Secret
    // Manager, for two reasons: the admin may have retyped only one field, so the
    // typed values alone are not a testable credential; and a credential that fails
    // its check is usually right-but-not-yet-consented, so keeping it stored lets the
    // admin fix permissions and retry instead of retyping everything. The response
    // says plainly which of the two happened.
    const merged: Record<string, string> = {};
    for (const [field, secretId] of Object.entries(secretIdByField)) {
      const got = await getEntraSecret(saToken, `projects/${secretsProject}/secrets/${secretId}/versions/latest`);
      if (got.ok && got.plaintext) merged[field] = got.plaintext;
    }
    const validation = await validateConnectorCredentials(connectorId, merged);
    if (validation.code !== 'ok') {
      logger.warn({ connectorId, code: validation.code }, 'connector credentials stored but did not validate');
    }
    res.json({ secretIds, validation });
  } catch (err) {
    res.status(502).json({ error: 'credentials_save_failed', detail: (err as Error).message });
  }
});

/**
 * GET /api/migrate/connector-requirements?session=…&ids=shared_jira,shared_teams
 *
 * Everything the UI needs to ask for a connector correctly, in one call:
 *   - which credential fields to show, and which are SHARED with sibling connectors
 *     (one Azure app serves all five Microsoft connectors; one Atlassian token serves
 *     Confluence and Jira) so we never ask for the same app twice
 *   - the exact API permissions to add, and whether an admin must consent — granting
 *     a credential is not granting access: a Microsoft client_credentials exchange
 *     returns a token even with nothing consented, then 403s on every call
 *   - whether this customer already configured the credential, so a newly-detected
 *     sibling connector asks only for the extra permission
 *
 * Contains no secret values — only field names, secret ids and permission strings.
 */
migrateRouter.get('/connector-requirements', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });

  const ids = String(req.query.ids ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (ids.length === 0) return void res.json({ connectors: [] });

  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const destProject = effectiveGeminiProject(session.geminiProject);
  const saved = await listConnectorCredentials(appUserId);
  // Only credentials stored in the project we are migrating INTO are usable — the
  // deployed container resolves secrets from its own project. See the GET route above.
  const usable = saved.filter((s) => !!destProject && s.project === destProject);
  const savedIds = new Set(usable.map((s) => s.connectorId));
  // Which individual FIELDS already have a secret, across the whole credential group.
  // Per-field state is what lets the UI stop demanding a value it already holds: a
  // returning admin was shown every input as required, so they retyped credentials
  // that were sitting in Secret Manager, and each retype wrote another secret version.
  const suppliedFieldsByScope = new Map<string, Set<string>>();
  for (const rec of usable) {
    const scope = connectorCredentialScope(rec.connectorId);
    const set = suppliedFieldsByScope.get(scope) ?? new Set<string>();
    for (const f of rec.fields ?? []) set.add(f);
    suppliedFieldsByScope.set(scope, set);
  }

  // A CUSTOM connector can never be in the registry, so it used to fall straight through
  // to `unknown: true` — no name, no fields, no way for the customer to supply its token.
  // Now that such a connector BINDS from its published definition, leaving it unknown is
  // the worse half of a working feature: the tools deploy and then fail to authenticate,
  // with the one screen that could have fixed it showing nothing to fill in. Resolve the
  // captured definition and describe the credential it states it wants.
  // A custom connector is defined PER ENVIRONMENT, so the lookup needs the environment id,
  // not just the tenant. Prefer the one the plan is actually migrating; the caller may also
  // name it explicitly. Without one we simply do not describe the connector — better than
  // guessing an environment and reporting another one's connector.
  const reqEnvUrl = String(req.query.env ?? '') || session.plan?.units?.[0]?.envUrl || '';
  const envId = reqEnvUrl
    ? session.environments?.find((e) => e.url.replace(/\/$/, '') === reqEnvUrl.replace(/\/$/, ''))?.id
    : undefined;
  const capCtx =
    session.tenantId && envId
      ? { tenantId: session.tenantId, environmentId: envId, scope: credentialScope(session) }
      : undefined;
  const discovered = new Map<string, { displayName: string; bindable: boolean }>();
  if (capCtx) {
    for (const id of ids) {
      if (REGISTRY_BY_ID.has(id)) continue;
      const index = await resolveOpIndex(id, capCtx).catch(() => undefined);
      if (index) discovered.set(id, { displayName: index.displayName, bindable: Boolean(index.vendorBinding) });
    }
  }

  const connectors = ids.map((id) => {
    const def = REGISTRY_BY_ID.get(id);
    if (!def) {
      const d = discovered.get(id);
      // Only claim a credential field where the definition told us what it wants. An
      // unbindable custom connector still gets its real NAME, which is the difference
      // between "shared_get-20crm-…" and "Get CRM objects from Hubspot" in the report.
      if (!d) return { connectorId: id, unknown: true };
      return {
        connectorId: id,
        name: d.displayName,
        custom: true,
        unknown: !d.bindable,
        category: 'custom',
        authKind: 'bearer' as const,
        fields: d.bindable
          ? [
              {
                key: 'api_key',
                label: `${d.displayName} API token`,
                help:
                  'This is a custom connector your team published. Its definition sends this value verbatim ' +
                  'as the Authorization header, so paste it exactly as the connector holds it today — ' +
                  'including any scheme prefix such as "Bearer ".',
                required: true,
                supplied: savedIds.has(id),
              },
            ]
          : [],
      };
    }
    const group = def.credentialGroup ? CREDENTIAL_GROUPS[def.credentialGroup] : undefined;
    const siblings = connectorsSharingCredentials(id);
    // A sibling already configured means the shared credential exists — the customer
    // only needs to add this connector's permissions to the app they already made.
    const credentialAlreadySupplied = savedIds.has(id) || siblings.some((s) => savedIds.has(s));

    return {
      connectorId: id,
      name: def.name,
      icon: def.icon,
      category: def.category,
      docsUrl: def.docsUrl,
      authKind: def.authKind ?? 'bearer',
      fields: connectorCredentialFields(id)
        .map((f) => ({
          key: f.key,
          label: f.label,
          type: f.type,
          placeholder: f.placeholder,
          hint: f.hint,
          shared: f.shared,
          // A value already exists for this field. The UI renders it as satisfied with a
          // Replace affordance instead of an empty required input, and omits it from the
          // save so an unchanged credential does not get a new version.
          supplied: suppliedFieldsByScope.get(connectorCredentialScope(id))?.has(f.key) ?? false,
        })),
      requiredPermissions: def.requiredPermissions ?? [],
      adminConsentRequired: !!def.adminConsentRequired,
      permissionsHint: def.permissionsHint,
      group: group
        ? { id: group.id, name: group.name, setupUrl: group.setupUrl, setupHint: group.setupHint, siblings }
        : undefined,
      configured: savedIds.has(id),
      credentialAlreadySupplied,
    };
  });

  res.json({ connectors });
});

/**
 * GET /api/migrate/connector-credentials?session=…
 *
 * Which connectors this customer has ALREADY configured, so the UI can render a
 * connector as "configured" instead of asking for credentials that are already in
 * Secret Manager. Returns field names and secret ids only — never a value, so this
 * response is safe to hold in the browser.
 */
/**
 * GET /api/migrate/connector-credential-value?session=…&connectorId=…&field=…
 *
 * Read back ONE stored credential value, so an admin can see what is currently configured
 * before changing it.
 *
 * This deliberately breaks the rule the sibling route above states ("never a value") and the
 * product owner asked for it explicitly: an admin editing a connector could not tell WHICH
 * credential was stored, only that one was, which made a wrong-tenant or stale-secret
 * situation impossible to diagnose from the UI.
 *
 * The exposure is real, so it is fenced as tightly as the feature allows:
 *   - ONE field per request, named explicitly. No bulk dump of every secret.
 *   - Fetched only when the admin clicks to reveal, never on page load, so a credential is
 *     not sitting in the response of a screen someone merely walked past.
 *   - Scoped by the session's own `appUserId` and by the destination project, exactly like
 *     every other credential read — a session can only ever see its own tenant's secrets.
 *   - The value is returned and never logged. `logger` must not touch `plaintext` here.
 *
 * What it does NOT do is make the value safe once it reaches the browser: it is then in page
 * memory, devtools and any screenshot. That is the accepted trade, not an oversight.
 */
migrateRouter.get('/connector-credential-value', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const connectorId = String(req.query.connectorId ?? '').trim();
  const field = String(req.query.field ?? '').trim();
  if (!connectorId || !field) {
    return void res.status(400).json({ error: 'connector_id_and_field_required' });
  }

  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const destProject = effectiveGeminiProject(session.geminiProject);
  if (!destProject) return void res.status(400).json({ error: 'no_destination_project' });

  // The record is looked up under THIS session's appUserId, so a client-supplied connectorId
  // can never reach another tenant's secret. Scope-matching also means a Microsoft field is
  // found on whichever ms_graph record holds it, the same way the save path merges them.
  const scope = connectorCredentialScope(connectorId);
  const saved = await listConnectorCredentials(appUserId);
  const rec = saved.find(
    (r) =>
      r.project === destProject &&
      (r.connectorId === connectorId || connectorCredentialScope(r.connectorId) === scope) &&
      !!r.secretIds?.[field],
  );
  if (!rec) return void res.status(404).json({ error: 'not_configured' });

  const secretId = rec.secretIds![field];
  try {
    const saToken = await getSaToken();
    const got = await getEntraSecret(saToken, `projects/${destProject}/secrets/${secretId}/versions/latest`);
    if (!got.ok || !got.plaintext) {
      return void res.status(502).json({ error: 'secret_unreadable', detail: got.error });
    }
    // No logging on this path, deliberately — not the value, and not a "revealed X" line that
    // would grow into an audit trail nobody asked for.
    res.json({ connectorId, field, value: got.plaintext });
  } catch (err) {
    res.status(502).json({ error: 'secret_read_failed', detail: (err as Error).message });
  }
});

migrateRouter.get('/connector-credentials', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const destProject = effectiveGeminiProject(session.geminiProject);
  const saved = await listConnectorCredentials(appUserId);
  // Secrets live in the project they were saved against. Migrating into a DIFFERENT
  // project cannot read them, so a record from another project must NOT read as
  // configured — live 2026-08-07 credentials saved during a GTM session made the UI
  // show "✓ Saved" while the studio run skipped every Confluence source as
  // "needs a connector or manual step".
  res.json({
    connectors: saved.map((s) => ({
      connectorId: s.connectorId,
      fields: s.fields,
      project: s.project,
      updatedAt: s.updatedAt,
      matchesDestination: !!destProject && s.project === destProject,
    })),
  });
});

/**
 * DELETE /api/migrate/connector-credentials?session=…&connectorId=…[&purge=true]
 *
 * Forget our record of a connector so the UI asks for credentials again. By default the
 * Secret Manager secrets stay in place — destroying customer secret material is an
 * explicit, irreversible action, not a side effect of "reconfigure this".
 *
 * `purge=true` is the deprovisioning path: it also deletes the secrets themselves, so a
 * departing customer's credentials do not live in the project forever. It deletes only
 * secrets no REMAINING connector still depends on — one Atlassian token backs both
 * Confluence and Jira, and purging Jira must not break a Confluence agent still running.
 */
migrateRouter.delete('/connector-credentials', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const connectorId = req.query.connectorId as string;
  if (!connectorId) return void res.status(400).json({ error: 'connector_id_required' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const purge = String(req.query.purge ?? '') === 'true';

  const record = purge ? await getConnectorCredential(appUserId, connectorId) : null;
  await deleteConnectorCredential(appUserId, connectorId);

  const purged: string[] = [];
  const purgeErrors: string[] = [];
  if (purge && record) {
    // Read the remaining records AFTER the delete, so "still in use" reflects the state
    // the customer is left with rather than the one they asked us to leave behind.
    const stillUsed = new Set(
      (await listConnectorCredentials(appUserId))
        .filter((r) => r.project === record.project)
        .flatMap((r) => Object.values(r.secretIds ?? {})),
    );
    const saToken = await getSaToken(session.gEmail);
    const scope = credentialScope(session);
    for (const secretId of new Set(Object.values(record.secretIds ?? {}))) {
      if (stillUsed.has(secretId)) continue;
      // Destroy is irreversible, and an id is not proof of ownership: credentials saved
      // before customer scoping carry no owner in the id, so on a deployment serving more
      // than one customer the same id can back several of them. Check the label on the
      // secret itself and refuse anything that is not demonstrably this customer's.
      const owner = await getSecretOwnership(saToken, record.project, secretId);
      if (!owner.found) {
        purgeErrors.push(`${secretId}: could not read the secret's metadata, so it was left in place`);
        continue;
      }
      if (!owner.managed) {
        purgeErrors.push(`${secretId}: not managed by Studio Migrate — left in place`);
        continue;
      }
      if (owner.owner && owner.owner !== scope) {
        purgeErrors.push(`${secretId}: belongs to another customer — left in place`);
        logger.warn({ secretId, project: record.project }, 'purge refused: secret owned by a different scope');
        continue;
      }
      if (!owner.owner) {
        // Written before ownership labelling. It may back another customer's running
        // agent, and there is no way to tell from here.
        purgeErrors.push(
          `${secretId}: saved before ownership labelling, so it cannot be proven to be yours — left in place. ` +
            'Delete it from Secret Manager directly if you are sure.',
        );
        continue;
      }
      const del = await deleteSecret(saToken, record.project, secretId);
      if (del.ok) purged.push(secretId);
      else purgeErrors.push(`${secretId}: ${del.error}`);
    }
  }
  res.json({ ok: true, purged, ...(purgeErrors.length ? { purgeErrors } : {}) });
});

/**
 * POST /api/migrate/ms-connector-credentials
 * body: { session, creds: { tenant_id, client_id, client_secret } }
 * Stores MS App Registration credentials for MS-native connectors (Teams, SP, O365).
 */
migrateRouter.post('/ms-connector-credentials', async (req, res) => {
  const { session: sessionId, creds } = req.body as {
    session?: string;
    creds?: Record<string, string>;
  };
  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!creds || Object.keys(creds).length === 0) {
    return void res.status(400).json({ error: 'creds_required' });
  }
  if (!session.geminiProject) return void res.status(400).json({ error: 'google_not_connected' });

  try {
    const saToken = await getSaToken(session.gEmail);
    // Secrets MUST go to the project the agent will be deployed into, or the deployed
    // container cannot read them. Apply the same override resolveDestination uses.
    const secretsProject = effectiveGeminiProject(session.geminiProject);
    const access = await preflightSecretAccess(secretsProject, saToken, serviceAccountEmail());
    if (!access.ok) return void res.status(403).json({ error: access.code, detail: access.detail });

    const secretIds: string[] = [];
    // Write to the SHARED ms_graph namespace — the same one buildLiveConnectorSpecs
    // hands to the deployed tools. This used to write 'ms_native', so credentials saved
    // through the UI landed under studio-enterprise-ms-native-* while every Graph tool
    // looked for studio-enterprise-ms-graph-*: the agent deployed fine and then failed
    // at inference with "no secret id configured", with nothing in typecheck or the
    // save flow to reveal the mismatch.
    const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
    // Any Microsoft connector's record carries the shared ms_graph ids, so read one to
    // find where these fields already live and merge rather than replace — an admin
    // changing only the client secret must not blank the tenant and client ids.
    const priorMs = (await listConnectorCredentials(appUserId)).find(
      (c) => REGISTRY_BY_ID.get(c.connectorId)?.credentialGroup === 'ms_graph' && c.project === secretsProject,
    );
    const secretIdByField: Record<string, string> = { ...(priorMs?.secretIds ?? {}) };
    for (const field of MS_APP_REG_FIELDS) {
      const value = creds[field.key];
      // Absent field means "leave as is" — the client omits what the admin did not
      // retype. An empty string would be a real value and is not treated as one here.
      if (!value) continue;
      const secretId = priorMs?.secretIds?.[field.key] ?? connectorSecretId('ms_graph', field.key, credentialScope(session));
      await upsertSecretIfChanged(saToken, secretsProject, secretId, value, {
        managed_by: 'studio-enterprise',
        app_user: appUserId,
        connector: 'ms_graph',
      });
      secretIds.push(secretId);
      secretIdByField[field.key] = secretId;
    }

    // One Azure app serves every Microsoft connector, so record all of them as
    // configured — otherwise a later-detected sibling (Teams after SharePoint) would
    // ask for credentials that already exist.
    const msConnectorIds = [...REGISTRY_BY_ID.values()]
      .filter((d) => d.credentialGroup === 'ms_graph')
      .map((d) => d.id);
    for (const connectorId of msConnectorIds) {
      await upsertConnectorCredential(appUserId, {
        connectorId,
        // secretsProject, NOT session.geminiProject: the secret was written to the
        // effective destination, and /connector-requirements only counts a credential
        // as configured when its recorded project matches that destination. Recording
        // the raw session project made every Microsoft connector ask for credentials
        // again whenever the destination override was in play.
        project: secretsProject,
        fields: Object.keys(secretIdByField),
        secretIds: secretIdByField,
      });
    }

    // Flag MS creds saved on the session plan, and register the connectors so the
    // orchestrator wires live Graph tools for them.
    const existingSaved = session.plan?.savedConnectors ?? [];
    const updated = {
      ...session.plan,
      msCreds: true,
      savedConnectors: [...new Set([...existingSaved, ...msConnectorIds])],
    };
    await updateSession(sessionId!, { plan: updated as typeof session.plan });

    // A minted token proves nothing here: Entra issues one for an app with no
    // application permissions consented, and every Graph call then 403s. Validate
    // against the merged stored set so an admin who retyped only the secret is not told
    // their tenant id is missing.
    const merged: Record<string, string> = {};
    for (const [field, secretId] of Object.entries(secretIdByField)) {
      const got = await getEntraSecret(saToken, `projects/${secretsProject}/secrets/${secretId}/versions/latest`);
      if (got.ok && got.plaintext) merged[field] = got.plaintext;
    }
    const validation = await validateConnectorCredentials('ms_graph', merged);
    if (validation.code !== 'ok') {
      logger.warn({ code: validation.code }, 'Microsoft app credentials stored but did not validate');
    }
    res.json({ secretIds, validation });
  } catch (err) {
    res.status(502).json({ error: 'ms_creds_save_failed', detail: (err as Error).message });
  }
});

/**
 * GET /api/migrate/runs?session=&limit=
 * Past runs for the signed-in tenant, newest first.
 *
 * The Fidelity report previously had no source for history — it could show only the run you
 * had just watched, and said so rather than inventing one. This is that source.
 */
migrateRouter.get('/runs', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  // Scope from the AUTHENTICATED session, never from a client-supplied value.
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const runs = await listRuns(appUserId, { limit: Number(req.query.limit) || 20 });
  res.json({ runs });
});

/**
 * GET /api/migrate/runs/:runId?session=
 * Every agent result for one past run.
 */
migrateRouter.get('/runs/:runId', async (req, res) => {
  const session = await getSession(req.query.session as string);
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const results = await getRunResults(appUserId, req.params.runId);
  // An unknown run and someone else's run are indistinguishable here on purpose: both are
  // simply "not found for you", which is the only answer that does not confirm the run
  // exists in another tenant.
  if (!results.length) return void res.status(404).json({ error: 'run_not_found' });
  res.json({ runId: req.params.runId, results });
});
