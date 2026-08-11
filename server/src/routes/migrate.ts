import { Router } from 'express';
import { runMigration } from '../orchestrator.js';
import { renderReportExcel } from '../services/report.js';
import { resolveScope } from '../services/scope.js';
import { getSession, updateSession, DEFAULT_APP_USER_ID } from '../sessionStore.js';
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
import { upsertSecretIfChanged, preflightSecretAccess, deleteSecret, getEntraSecret } from '../services/secretManager.js';
import { validateConnectorCredentials } from '../services/connectorValidator.js';
import { logger } from '../logger.js';
import { serviceAccountEmail } from '../auth/google.js';
import {
  connectorSecretId,
  connectorCredentialFields,
  connectorCredentialScope,
  connectorsSharingCredentials,
} from '../services/connectorCredentials.js';
import { REGISTRY_BY_ID, CREDENTIAL_GROUPS } from '../connectors/registry.js';
import { MS_APP_REG_FIELDS } from '../services/connectorToolBuilder.js';
import type { DestinationOptions, GeminiDestination, MigrationResult, MigrationScope } from '../types.js';

export const migrateRouter = Router();

/**
 * Resolve a migration scope into a concrete plan, store it on the session, and
 * return a preview (what will migrate + destination naming). Call before /stream.
 */
migrateRouter.post('/plan', async (req, res) => {
  const { session: sessionId, scope, destination, dryRun, forceRedeploy } = req.body as {
    session?: string;
    scope?: MigrationScope;
    destination?: DestinationOptions;
    dryRun?: boolean;
    /** Redeploy already-migrated agents even when their source is unchanged. */
    forceRedeploy?: boolean;
  };
  const session = await getSession(sessionId ?? '');
  if (!session) return void res.status(404).json({ error: 'session_not_found' });
  if (!scope) return void res.status(400).json({ error: 'scope_required' });

  try {
    const dest = destination ?? {};
    const plan = await resolveScope(session, scope, dest);
    plan.dryRun = !!dryRun;
    plan.forceRedeploy = !!forceRedeploy;
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
    const connectors = await detectKnowledgeConnectors(envUrl, dvToken, botIds, botNames);
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
      const secretId = priorRecord?.secretIds?.[field] ?? connectorSecretId(connectorId, field, appUserId);
      // Labels are the only way to tell later which tenant and connector a secret
      // belongs to — the id alone cannot be queried, so without these there is no way
      // to enumerate a customer's credentials in order to audit or remove them.
      await upsertSecretIfChanged(saToken, secretsProject, secretId, value, {
        managed_by: 'studio-enterprise',
        app_user: appUserId,
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

  const connectors = ids.map((id) => {
    const def = REGISTRY_BY_ID.get(id);
    if (!def) return { connectorId: id, unknown: true };
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
      fields: connectorCredentialFields(id).map((f) => ({
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
    for (const secretId of new Set(Object.values(record.secretIds ?? {}))) {
      if (stillUsed.has(secretId)) continue;
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
      const secretId = priorMs?.secretIds?.[field.key] ?? connectorSecretId('ms_graph', field.key, appUserId);
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
