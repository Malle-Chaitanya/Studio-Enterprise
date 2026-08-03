import { clientCredsToken } from './auth/microsoft.js';
import { getSaToken, serviceAccountEmail } from './auth/google.js';
import { logger } from './logger.js';
import { extractAgent, fetchFileAttachmentBytes, resolveSystemUserEmail } from './services/dataverse.js';
import { findCandidates } from './services/graphSearch.js';
import { buildOrganizationProfile } from './services/organizationProfile.js';
import { createAgent, defaultDestination, resolveDestination, projectReachable, publishAgent, shareAgent, type CreateOutcome } from './services/gemini.js';
import { uploadAgentFile, updateAgentFiles, getAgent, readAgentFiles, mimeTypeForFile, type AgentFile } from './services/geminiAgentFiles.js';
import { mapAgent } from './services/mapper.js';
import { migrateDataverseSnapshot, migrateSharePointDriveItem } from './services/knowledgeDataStoreExecutor.js';
import { attachDataStoreToEngine } from './services/geminiDataStore.js';
import { getConnectorOperation, getConnectorDataStores } from './services/geminiConnector.js';
import { getKnowledgeConnector, markKnowledgeConnectorStatus } from './db/repos/knowledgeConnectors.js';
import { firstWebsiteSource, publishAgentToGallery } from './services/adkDeployer.js';
import { getAdkDeployment, recordAdkDeployment } from './db/repos/adkDeployments.js';
import { planTopicsMigration } from './services/topicsMigration.js';
import { verifyAgent } from './services/verify.js';
import { preflightQuota, nextQuotaResetUtc } from './services/quota.js';
import { DEFAULT_APP_USER_ID, newId, type Session } from './sessionStore.js';
import { appendLog, finishRun, saveResult, startRun } from './db/repos/migrations.js';
import { cacheAgentIR } from './db/repos/agentIR.js';
import { listStaged, markStaged, stageAgent } from './db/repos/staged.js';
import type { AgentIR, GeminiDestination, MigrationResult, ProgressEvent, ResolvedPlan } from './types.js';

/** Strip extension + OneDrive/Windows dedup suffixes (" -1)", " (1)") and lowercase, for name comparison only. */
function normalizeForNameCompare(name: string): string {
  return name
    .replace(/\.[^./\\]+$/, '')
    .replace(/\s*[-(]\s*\d+\)?\s*$/, '')
    .trim()
    .toLowerCase();
}

/**
 * Whether a single Graph search hit plausibly matches the knowledge source's
 * own name — required before trusting a "1 result" as a confident automatic
 * match. Graph's `/search(q=...)` is Microsoft Search: relevance/full-text
 * across content AND metadata, not a strict filename-equals lookup, so a lone
 * hit can still be an unrelated file that merely ranked as the sole relevant
 * result (confirmed live: searching a folder name, not a filename, returned
 * one unrelated document). Only treat the result as confident when its name
 * actually resembles what was searched for.
 */
function isPlausibleFilenameMatch(sourceName: string, candidateName: string): boolean {
  const a = normalizeForNameCompare(sourceName);
  const b = normalizeForNameCompare(candidateName);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Migrate an agent's uploaded knowledge files (Copilot Bot File Attachments)
 * into the Gemini agent's `agentFiles`: fetch bytes from Dataverse → upload via
 * files:upload → attach via UpdateAgent. Runs after the agent exists (files are
 * a sub-resource of the agent). Non-file sources (websites, Dataverse) are
 * handled separately. Never throws — reports counts.
 */
interface KnowledgeFileFailure {
  name: string;
  /** Clean, customer-facing reason — never a raw Google error blob. */
  reason: string;
}

interface KnowledgeFileOutcome {
  uploaded: number;
  failed: number;
  skipped: number;
  failures: KnowledgeFileFailure[];
}

/**
 * Turn a raw upstream error (Dataverse download failure, or Google's upload/
 * attach error text) into a short, honest, human-readable reason — never the
 * raw error blob. Callers surface this in logs AND the fidelity report, so it
 * has to make sense to someone who isn't reading our code.
 */
function cleanUploadFailureReason(raw: string): string {
  if (/MODEL_ARMOR_VIOLATION/i.test(raw)) {
    return "Rejected by Google's Model Armor content-safety scan on upload — this is a Google Cloud platform-level check on the file's content, not a migration tool issue. Review the document's content or the project's Model Armor policy with your Google Cloud admin.";
  }
  const firstLine = raw.split('\n')[0].trim();
  return firstLine.slice(0, 300) || 'unknown upload error';
}

async function attachKnowledgeFiles(
  dest: GeminiDestination,
  saToken: string,
  agentId: string,
  ir: AgentIR,
  envUrl: string,
  dvToken: string,
): Promise<KnowledgeFileOutcome> {
  const files = ir.knowledgeSources.filter((k) => k.kind === 'FileUpload' && k.file?.name);
  if (!files.length) return { uploaded: 0, failed: 0, skipped: 0, failures: [] };

  // Idempotent: skip files already attached (by filename) so re-migration never
  // stacks duplicates — enterprise runs must be safely repeatable.
  const existing = readAgentFiles(await getAgent(dest, saToken, agentId));
  const existingNames = new Set(existing.map((f) => f.fileName));

  const refs: AgentFile[] = [];
  const failures: KnowledgeFileFailure[] = [];
  let skipped = 0;
  for (const k of files) {
    const name = k.file!.name!;
    if (existingNames.has(name)) { skipped++; continue; } // already on the agent
    if (k.file?.compatible === false) { skipped++; continue; } // fails Gemini's ingest gate
    const got = await fetchFileAttachmentBytes(envUrl, dvToken, k.id);
    if (!got) { failures.push({ name, reason: 'could not download the file from Dataverse (see server logs for the HTTP status).' }); continue; }
    const up = await uploadAgentFile(dest, saToken, agentId, {
      fileName: name,
      mimeType: mimeTypeForFile(name, got.contentType),
      bytes: got.bytes,
    });
    if (!up.ok) { failures.push({ name, reason: cleanUploadFailureReason(up.error ?? 'unknown upload error') }); continue; }
    const ref = (up.raw as { agentFile?: AgentFile }).agentFile;
    if (ref?.name) refs.push(ref);
    else failures.push({ name, reason: 'Gemini accepted the upload but did not return a file reference — could not attach it to the agent.' });
  }

  if (refs.length) {
    const merged = [...existing, ...refs];
    const res = await updateAgentFiles(dest, saToken, agentId, merged);
    if (!res.ok) {
      const reason = cleanUploadFailureReason(res.error ?? 'failed to attach the uploaded file to the agent');
      for (const r of refs) failures.push({ name: r.fileName, reason });
      return { uploaded: 0, failed: failures.length, skipped, failures };
    }
  }
  return { uploaded: refs.length, failed: failures.length, skipped, failures };
}

/**
 * Two-phase, batched, fetch-then-migrate engine.
 *
 *   PHASE 1 — EXTRACT:  Copilot Studio → transform → LOAD into DB (stagedAgents)
 *   PHASE 2 — INSERT:   read staged rows from DB → create/publish/share/verify in Gemini
 *
 * Both phases run their work-list through a bounded-concurrency pool (default 5)
 * so we parallelise without tripping Gemini's rate limits (the gemini service
 * already backs off on 429/503). Staging in the DB decouples the phases: a
 * failed insert run can be retried from the staged rows without re-extracting.
 */

const CONCURRENCY = 5; // Phase 1 (Dataverse reads) — safe to parallelize
// Phase 2 (Gemini writes) is what hits Discovery Engine's write quota (429s), so
// insert with a smaller burst. Combined with jittered backoff, this cuts retries.
const INSERT_CONCURRENCY = 3;

/** Run items through `fn` with at most `limit` in flight at once. */
async function mapPool<T>(
  items: T[],
  limit: number,
  fn: (item: T, idx: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = next++;
      if (idx >= items.length) return;
      await fn(items[idx], idx);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/**
 * Single-consumer async queue so concurrent workers can push progress events
 * while the SSE route drains them in order.
 */
class EventQueue {
  private buf: ProgressEvent[] = [];
  private waiters: ((r: IteratorResult<ProgressEvent>) => void)[] = [];
  private ended = false;

  push(e: ProgressEvent): void {
    const w = this.waiters.shift();
    if (w) w({ value: e, done: false });
    else this.buf.push(e);
  }
  end(): void {
    this.ended = true;
    let w: ((r: IteratorResult<ProgressEvent>) => void) | undefined;
    while ((w = this.waiters.shift())) w({ value: undefined as never, done: true });
  }
  async *stream(): AsyncGenerator<ProgressEvent> {
    for (;;) {
      if (this.buf.length) {
        yield this.buf.shift()!;
        continue;
      }
      if (this.ended) return;
      const r = await new Promise<IteratorResult<ProgressEvent>>((res) => this.waiters.push(res));
      if (r.done) return;
      yield r.value;
    }
  }
}

/**
 * Public entry point — an async generator the SSE route consumes. The heavy
 * lifting runs concurrently in execute(); events flow out through the queue.
 */
export async function* runMigration(
  session: Session,
  plan: ResolvedPlan,
): AsyncGenerator<ProgressEvent> {
  const q = new EventQueue();
  const run = execute(session, plan, (e) => q.push(e))
    .catch((err) => {
      logger.error({ err }, 'migration crashed');
      q.push({ type: 'log', level: 'fail', msg: `Fatal: ${(err as Error).message}` });
      q.push({ type: 'done', summary: 'Migration failed unexpectedly.', results: [] });
    })
    .finally(() => q.end());
  yield* q.stream();
  await run;
}

type Emit = (e: ProgressEvent) => void;

async function execute(session: Session, plan: ResolvedPlan, emit: Emit): Promise<void> {
  const project = session.geminiProject ?? '';
  const gEmail = session.gEmail ?? '';
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const runId = newId();
  const results: MigrationResult[] = [];

  // Resolve each source environment to its Gemini destination. If the customer
  // mapped the environment (environmentMap), route there; otherwise use the
  // connected project's default engine — DISCOVERED from the project (see below)
  // so the tool works against any client's project without a hardcoded engine id.
  const envMap = plan.destination.environmentMap ?? {};
  let resolvedDefault = defaultDestination(project); // sync fallback; replaced after auth
  const targetFor = (envUrl: string): GeminiDestination => envMap[envUrl] ?? resolvedDefault;

  const emitLog = (level: 'info' | 'ok' | 'warn' | 'fail', msg: string): void => {
    void appendLog(runId, appUserId, level, msg); // DB — keep rich Unicode
    emit({ type: 'log', level, msg }); // browser UI — keep rich Unicode
    // Mirror to the server console as ASCII so it renders on every terminal
    // (the Windows console code page mangles →/──/·/⚠ into "ΓåÆ" etc).
    const c = msg
      .replace(/→/g, '->')
      .replace(/──/g, '--')
      .replace(/[·•]/g, '-')
      .replace(/⚠/g, '[!]')
      .replace(/[^\x00-\x7F]/g, '') // drop any remaining non-ASCII
      .trim();
    if (level === 'fail') logger.error({ runId }, c);
    else if (level === 'warn') logger.warn({ runId }, c);
    else logger.info({ runId }, c);
  };
  const emitProg = (pct: number, msg: string): void => emit({ type: 'progress', pct, msg });

  await startRun({
    runId,
    appUserId,
    orgName: session.orgName,
    scope: { kind: 'tenant' },
    plan,
    destination: plan.destination,
  });

  // ── Auth (service account, needed for the insert phase) ───────────────────
  emitProg(2, 'Authenticating via service account…');
  let saToken = '';
  if (!plan.dryRun) {
    try {
      // Prefer impersonating the connected admin (Domain-Wide Delegation) so
      // migrated agents are owned by the customer's own admin account, not
      // CloudFuze's SA — SA-owned agents would be orphaned from any customer
      // identity if the SA's direct IAM grant is later revoked. Direct IAM is
      // the fallback for clients who only authorized that.
      let ok = false;
      if (gEmail) {
        try {
          const impersonated = await getSaToken(gEmail); // impersonate client admin (DWD)
          if (!project || (await projectReachable(project, impersonated))) {
            saToken = impersonated;
            ok = true;
            emitLog('ok', `Using CloudFuze service account impersonating ${gEmail} (Domain-Wide Delegation)`);
          }
        } catch (err) {
          logger.warn({ err }, 'DWD impersonation unavailable; falling back to direct IAM');
        }
      }
      if (!ok) {
        const direct = await getSaToken(); // SA's own identity (client granted IAM)
        if (!project || (await projectReachable(project, direct))) {
          saToken = direct;
          ok = true;
          emitLog('ok', `Using CloudFuze service account (granted IAM on project ${project})`);
        }
      }
      if (!ok) throw new Error('no-access');
      // Client-agnostic: discover the project's actual engine instead of assuming
      // a hardcoded name, so the destination is correct for any client project.
      resolvedDefault = await resolveDestination(project, saToken);
      emitLog('info', `Destination engine: ${resolvedDefault.engine} (project ${project})`);
    } catch {
      const saEmail = serviceAccountEmail() ?? 'the service account';
      const aborted = `Google access not granted for project ${project || '?'} — grant ${saEmail} the "Discovery Engine Admin" role (or authorize it in Domain-Wide Delegation).`;
      emitLog('warn', aborted);
      await finishRun(runId, aborted, 'aborted');
      emit({ type: 'done', summary: aborted, results });
      return;
    }
  }

  // Flat work-list across every environment in the plan.
  const workItems = plan.units.flatMap((u) =>
    u.bots.map((bot) => ({ envUrl: u.envUrl, envName: u.envName, bot })),
  );
  const total = workItems.length;
  if (total === 0) {
    const empty = 'Nothing to migrate — the selected scope had no agents.';
    await finishRun(runId, empty, 'empty');
    emit({ type: 'done', summary: empty, results });
    return;
  }
  emitLog('info', `Scope: ${total} agent(s) across ${plan.units.length} environment(s) · concurrency ${CONCURRENCY}`);

  // Cache one app-only Dataverse token per environment (acquired lazily, once).
  const tokenCache = new Map<string, Promise<string>>();
  const tokenFor = (envUrl: string): Promise<string> => {
    let t = tokenCache.get(envUrl);
    if (!t) {
      t = clientCredsToken(session.tenantId ?? '', envUrl);
      tokenCache.set(envUrl, t);
    }
    return t;
  };
  // One Microsoft Graph token for the whole run (not per-environment — Graph
  // isn't scoped to a Dataverse org the way Dataverse tokens are). Used to
  // search SharePoint/OneDrive for FederatedStructuredSearchSource sources
  // (the "upload and sync" copy-mode type with no auto-discoverable URL).
  let graphTokenPromise: Promise<string> | null = null;
  const graphToken = (): Promise<string> => {
    if (!graphTokenPromise) graphTokenPromise = clientCredsToken(session.tenantId ?? '', 'https://graph.microsoft.com');
    return graphTokenPromise;
  };

  // Build the organization profile once — kept for future phases (report/
  // reconnect setup) even though nothing currently reads ownedDomains here.
  const orgProfile = await buildOrganizationProfile(session, new Date().toISOString());
  if (orgProfile.ownedDomains.length) {
    emitLog('info', `Org profile: owned domains [${orgProfile.ownedDomains.join(', ')}] via ${orgProfile.domainSources.join(', ') || 'none'}`);
  }

  // ── PHASE 1 — EXTRACT → stage in DB (parallel, batched) ───────────────────
  emitLog('info', `── Phase 1: extract → stage in DB (${total} agents) ──`);
  let extracted = 0;
  await mapPool(workItems, CONCURRENCY, async (item) => {
    try {
      const token = await tokenFor(item.envUrl);
      const ir = await extractAgent(item.envUrl, token, item.bot);
      // Compile topics ONCE (Topic → Capability → Connected-Agent plan) and feed
      // it to the mapper so its procedures are folded into the instruction, and
      // stage a flat, queryable copy of the capabilities.
      const topicsPlan = planTopicsMigration(ir);
      const mapped = await mapAgent(ir, { topicsPlan });
      const capabilities = [...topicsPlan.systemCapabilities, ...topicsPlan.connectedAgents.flatMap((a) => a.capabilities)];

      // Name prefixing is opt-in via the "prefix with source environment"
      // toggle only (default off → clean names). The legacy `projects` label is
      // a routing hint, NOT a naming directive, so it must not alter the name.
      if (plan.destination.prefixWithEnv) mapped.displayName = `[${item.envName}] ${mapped.displayName}`;

      await stageAgent({
        runId,
        appUserId,
        envUrl: item.envUrl,
        envName: item.envName,
        sourceId: item.bot.botid,
        name: item.bot.name,
        displayName: mapped.displayName,
        status: 'staged',
        mapped,
        fidelity: mapped.fidelityNotes,
        sourceInstructions: ir.instructions,
        sourceDescription: ir.description,
        targetInstruction: mapped.instruction,
        targetDescription: mapped.description,
        topicCount: ir.topics.length,
        thinContent: ir.thinContent,
        sourceType: ir.sourceMetadata?.type,
        sourceOwnerId: ir.sourceMetadata?.ownerId,
        sourceCreatedOn: ir.sourceMetadata?.createdOn,
        sourceModifiedOn: ir.sourceMetadata?.modifiedOn,
        sourceProtected: ir.sourceMetadata?.protected,
        sourceManaged: ir.sourceMetadata?.isManaged,
        sourceStatus: ir.sourceMetadata?.status,
        knowledgeCount: ir.knowledgeSources.length,
        knowledgeAutoMigratable: ir.knowledgeSources.filter((k) => k.classification?.automatable).length,
        knowledgeManual: ir.knowledgeSources.filter((k) => !k.classification?.automatable).length,
        knowledge: ir.knowledgeSources.map((k) => ({
          id: k.id,
          name: k.name,
          kind: k.kind,
          reference: k.references?.[0] ?? k.reference,
          description: k.description,
          strategy: k.classification?.strategy ?? 'manual-review',
          geminiTarget: k.classification?.geminiTarget ?? 'none',
          retrievability: k.classification?.retrievability ?? 'unknown',
          automatable: Boolean(k.classification?.automatable),
          fileFormat: k.file?.format,
          fileCompatible: k.file?.compatible,
          componentType: k.metadata?.componentType,
          createdOn: k.metadata?.createdOn,
          modifiedOn: k.metadata?.modifiedOn,
          isManaged: k.metadata?.isManaged,
          status: k.metadata?.status,
        })),
        topicCapabilities: capabilities.map((c) => ({
          id: c.id,
          name: c.name,
          domain: c.domain,
          classification: c.classification,
          fidelity: c.fidelity,
          determinism: c.determinism,
          triggers: c.triggers,
          toolCount: c.tools.length,
          usesKnowledge: c.usesKnowledge,
          stateIn: c.stateIn,
          stateOut: c.stateOut,
          unresolvedState: c.unresolvedState,
          needsHumanReview: c.needsHumanReview,
          nodeCount: c.provenance.nodeCount,
        })),
        topicsSummary: {
          capabilities: topicsPlan.summary.capabilities,
          connectedAgents: topicsPlan.summary.connectedAgents,
          fullFidelity: topicsPlan.summary.byFidelity.full,
          partialFidelity: topicsPlan.summary.byFidelity.partial,
          needsReview: topicsPlan.summary.needsReview,
          deterministicTools: topicsPlan.summary.deterministicTools,
          unresolvedInputs: topicsPlan.summary.unresolvedInputs,
        },
      });
      void cacheAgentIR(appUserId, item.envUrl, ir, mapped);
      // Detailed, per-agent log so you can see exactly what was captured.
      const ksAuto = ir.knowledgeSources.filter((k) => k.classification?.automatable).length;
      const ksTotal = ir.knowledgeSources.length;
      const ts = topicsPlan.summary;
      emitLog(
        ir.thinContent ? 'warn' : 'ok',
        `  staged: ${item.bot.name} · src-instr=${ir.instructions.length}ch · desc=${ir.description.length}ch · topics=${ir.topics.length}` +
          (ts.capabilities ? ` · caps=${ts.capabilities} (${ts.byFidelity.full}✓/${ts.byFidelity.high}~/${ts.byFidelity.partial}!) review=${ts.needsReview} detTools=${ts.deterministicTools}` : '') +
          (ksTotal ? ` · knowledge=${ksAuto}/${ksTotal} auto` : '') +
          (ir.thinContent ? ' · ⚠ THIN (prebuilt/AI-Builder — needs manual authoring)' : ''),
      );
    } catch (err) {
      await stageAgent({
        runId,
        appUserId,
        envUrl: item.envUrl,
        envName: item.envName,
        sourceId: item.bot.botid,
        name: item.bot.name,
        displayName: item.bot.name,
        status: 'failed',
        fidelity: [],
        error: (err as Error).message,
      });
      emitLog('fail', `  extract failed: ${item.bot.name} — ${(err as Error).message}`);
    } finally {
      extracted++;
      emitProg(5 + Math.round(45 * (extracted / total)), `Extracting ${extracted}/${total}`);
    }
  });

  const staged = await listStaged(runId, 'staged');
  emitLog('info', `Phase 1 complete: ${staged.length}/${total} staged in DB`);

  // ── Dry run: report what WOULD be inserted, stop before touching Gemini ────
  if (plan.dryRun) {
    for (const row of staged) {
      const result: MigrationResult = {
        sourceId: row.sourceId,
        name: row.name,
        created: false,
        deployed: false,
        shared: false,
        fidelity: row.fidelity,
        error: 'dry-run (not created)',
      };
      results.push(result);
      void saveResult(runId, appUserId, result);
      emit({ type: 'agent', result });
      emitLog('ok', `  [dry run] would create "${row.displayName}" — ${row.fidelity.length} fidelity note(s)`);
    }
    emitProg(100, 'Dry run complete');
    const summary = `Dry run · ${staged.length}/${total} agents staged & ready to insert`;
    await finishRun(runId, summary, 'done');
    emit({ type: 'done', summary, results });
    return;
  }

  // ── PHASE 2 — INSERT from DB → Gemini (parallel, batched) ─────────────────
  emitLog('info', `── Phase 2: insert ${staged.length} staged agent(s) → Gemini ──`);

  // Pre-flight quota check: warn up-front how many fit today so a big migration
  // degrades transparently across the daily reset instead of surprising the
  // customer mid-run. Never blocks — backoff + resume remain the safety net.
  const pre = await preflightQuota(project, staged.length);
  emitLog(pre.overflow > 0 ? 'warn' : 'info', pre.message);

  let inserted = 0;
  // Once the project's (license-based) agent-creation quota is exhausted,
  // remaining creates can't succeed — halt fast with an actionable message
  // instead of grinding every agent through the same RESOURCE_EXHAUSTED failure.
  let quotaExhausted = false;
  await mapPool(staged, INSERT_CONCURRENCY, async (row) => {
    const result: MigrationResult = {
      sourceId: row.sourceId,
      name: row.name,
      created: false,
      deployed: false,
      shared: false,
      fidelity: row.fidelity,
    };
    try {
      if (quotaExhausted) {
        result.error = 'skipped — Gemini agent-creation quota exhausted earlier in this run';
        await markStaged(runId, row.sourceId, { status: 'skipped', error: result.error });
        emitLog('warn', `  ${row.name}: skipped (quota exhausted)`);
        return; // finally still records the result
      }
      if (!row.mapped) throw new Error('staged row missing mapped agent');
      const dest = targetFor(row.envUrl); // route to THIS environment's engine

      // ADK/Reasoning-Engine fallback: on some projects a low-code agent
      // comes back state: PRIVATE and NEVER moves to ENABLED — gallery-
      // invisible forever, no API/console/IAM fix (see adkDeployer.ts).
      // Low-code stays the cheap default for every agent; ADK only fires
      // when low-code create fails outright, or succeeds but can't reach
      // ENABLED. This is a fallback, not a default double-create.
      const lowCode = await createAgent(dest, saToken, row.mapped);
      const needsAdkFallback =
        !lowCode.alreadyExists && (!lowCode.created || !lowCode.agentId || lowCode.state !== 'ENABLED');
      // Tracks whether the FINAL create.agentId is actually the ADK/Reasoning-
      // Engine agent (vs. the stuck-PRIVATE low-code one kept as a fallback-
      // failed consolation) — downstream publish/share/knowledge-file logic
      // branches on this, so it must reflect the real outcome, not just
      // "did we attempt ADK".
      let usedAdk = false;
      const create: CreateOutcome = !needsAdkFallback
        ? lowCode
        : await (async () => {
            // Idempotency: Reasoning Engine `create` has no name-based dedup of
            // its own (unlike low-code's agents.create) — check our own record
            // FIRST so a re-run reuses the existing deployment instead of
            // minting a second, billable Reasoning Engine.
            const existing = await getAdkDeployment(appUserId, row.envUrl, row.sourceId, dest);
            if (existing) {
              usedAdk = true;
              return { created: true, agentId: existing.agentId, alreadyExists: true };
            }
            const websiteSource = firstWebsiteSource(row.mapped!.ir);
            const adk = await publishAgentToGallery(dest, saToken, row.mapped!.ir, { websiteSource });
            if (adk.ok && adk.agentId && adk.reasoningEngine) {
              await recordAdkDeployment(appUserId, row.envUrl, row.sourceId, dest, {
                reasoningEngine: adk.reasoningEngine,
                agentId: adk.agentId,
              });
              emitLog(
                'warn',
                `  ${row.name}: low-code ${lowCode.created ? `stayed ${lowCode.state ?? 'PRIVATE'}` : 'create failed'} — fell back to ADK (now ${adk.state})`,
              );
              usedAdk = true;
              return { created: true, agentId: adk.agentId };
            }
            // Both paths came up short. Prefer the low-code agent if it at
            // least exists (PRIVATE, not gallery-visible, but not nothing) so
            // it isn't silently orphaned from the result; only treat this as
            // a hard create failure if low-code failed too. Either way this
            // agent is NOT the ADK one, so usedAdk stays false.
            return lowCode.created && lowCode.agentId
              ? {
                  created: true,
                  agentId: lowCode.agentId,
                  state: lowCode.state,
                  error: `stayed ${lowCode.state ?? 'PRIVATE'}; ADK fallback failed: ${adk.error}`,
                }
              : { created: false, error: lowCode.error ?? `create failed; ADK fallback also failed: ${adk.error}` };
          })();
      // Only meaningful once usedAdk is settled above — a website source is
      // only actually grounded when the final agent really is the ADK one.
      const adkWebsiteSource = usedAdk ? firstWebsiteSource(row.mapped.ir) : undefined;
      if (create.alreadyExists) {
        result.error = 'already exists';
        await markStaged(runId, row.sourceId, { status: 'skipped', error: 'already exists' });
        emitLog('warn', `  ${row.name}: already exists — skipped`);
      } else if (!create.created || !create.agentId) {
        result.error = create.error ?? 'create failed';
        const isQuota = /RESOURCE_EXHAUSTED|quota exceeded/i.test(result.error);
        await markStaged(runId, row.sourceId, { status: 'failed', error: result.error });
        if (isQuota) {
          quotaExhausted = true;
          emitLog('fail', `  ${row.name}: Gemini agent-creation quota exhausted (RESOURCE_EXHAUSTED). This is a license/seat-based project quota — raise seats/quota for this Gemini project, or migrate fewer agents. Halting remaining inserts.`);
        } else {
          emitLog('fail', `  ${row.name}: create failed — ${result.error}`);
        }
      } else {
        result.created = true;
        result.geminiAgentId = create.agentId;

        // Migrate knowledge sources. FILES → agentFiles (wired, before publish
        // so the published revision includes them). Non-file sources (websites,
        // Dataverse) use the data-store path — not yet wired; reported honestly.
        const ks = row.mapped.ir.knowledgeSources;
        const fileSources = ks.filter((k) => k.kind === 'FileUpload');
        if (usedAdk) {
          // Confirmed 2026-07-31 (live, on a real re-deployed agent): ADK/Agent
          // Engine agents don't carry agentFiles at all — knowledge must be baked
          // into the deployed code (like the website tool below). Attaching files
          // here would silently no-op, so report it honestly instead of trying.
          for (const f of fileSources) {
            result.fidelity.push({
              component: `knowledge:${f.file?.name ?? f.name}`,
              status: 'lost',
              detail: 'Uploaded file not carried into the ADK (Agent Engine) deployment — this agent path only supports knowledge baked into its own code (e.g. VertexAiSearchTool). Re-attach manually if needed.',
            });
          }
          if (fileSources.length) {
            emitLog('warn', `    ${fileSources.length} uploaded file(s) NOT migrated — ADK deployment path doesn't support agentFiles yet.`);
          }
        } else if (fileSources.length) {
          try {
            const dvToken = await tokenFor(row.envUrl);
            const kf = await attachKnowledgeFiles(dest, saToken, create.agentId, row.mapped.ir, row.envUrl, dvToken);
            result.knowledgeFilesUploaded = kf.uploaded;
            result.knowledgeFilesFailed = kf.failed;
            emitLog(
              kf.failed ? 'warn' : 'ok',
              `    knowledge files: ${kf.uploaded} uploaded` +
                (kf.failed ? `, ${kf.failed} failed` : '') +
                (kf.skipped ? `, ${kf.skipped} skipped (incompatible)` : ''),
            );
            // Real, per-file reason — both in the logs and in the fidelity
            // report, never silently swallowed as just a bare count.
            for (const f of kf.failures) {
              emitLog('warn', `    "${f.name}" not attached: ${f.reason}`);
              result.fidelity.push({ component: `knowledge:${f.name}`, status: 'lost', detail: f.reason });
            }
          } catch (e) {
            emitLog('warn', `    knowledge file migration error: ${(e as Error).message}`);
          }
        }
        if (adkWebsiteSource) {
          result.fidelity.push({
            component: `knowledge:${adkWebsiteSource.name}`,
            status: 'mapped',
            detail: `Public website grounded via ADK's VertexAiSearchTool over a basic-tier website data store (${adkWebsiteSource.reference ?? adkWebsiteSource.references?.[0] ?? 'URL'}) — bypasses the no-code app's website-attach restriction.`,
          });
          emitLog('ok', `    public website "${adkWebsiteSource.name}": grounded via ADK VertexAiSearchTool.`);
        }
        // Dataverse reference tables → structured data store (wired below).
        // Everything else non-file (websites, connectors, sensitive tables,
        // manual-review) has no automatic path yet — reported honestly.
        const nonFile = ks.filter((k) => k.kind !== 'FileUpload' && k !== adkWebsiteSource);
        const dvSnapshots = nonFile.filter((k) => k.classification?.strategy === 'dataverse-snapshot');
        const stillUnwired = nonFile.filter((k) => k.classification?.strategy !== 'dataverse-snapshot');

        for (const src of dvSnapshots) {
          try {
            const dvToken = await tokenFor(row.envUrl);
            const snap = await migrateDataverseSnapshot(dest, saToken, dvToken, row.envUrl, create.agentId, src);
            result.knowledgeTableRowsIndexed = (result.knowledgeTableRowsIndexed ?? 0) + snap.succeeded;
            result.knowledgeTableRowsFailed = (result.knowledgeTableRowsFailed ?? 0) + snap.failed;
            emitLog(
              snap.error || snap.failed ? 'warn' : 'ok',
              `    Dataverse snapshot "${src.name}": ${snap.succeeded}/${snap.attempted} row(s) indexed` +
                (snap.failed ? `, ${snap.failed} failed` : '') +
                (snap.error ? ` — ${snap.error}` : ''),
            );
          } catch (e) {
            emitLog('warn', `    Dataverse snapshot "${src.name}" error: ${(e as Error).message}`);
          }
        }
        if (stillUnwired.length) {
          const spSources = stillUnwired.filter((k) => k.classification?.geminiTarget === 'sharepoint-connector');
          const other = stillUnwired.filter((k) => k.classification?.geminiTarget !== 'sharepoint-connector');

          // SharePoint native-connector reconnect: look up the per-site connector
          // (knowledgeConnectors.ts — one row per site, not a session singleton),
          // poll it to completion if still provisioning, discover the data
          // store(s) it created, and attach them to this agent's engine via the
          // same attachDataStoreToEngine the Dataverse-snapshot path already
          // uses. Every outcome gets an honest FidelityNote — never log-only.
          for (const src of spSources) {
            const siteUrl = (src.reference ?? src.references?.[0] ?? '').trim();
            if (!siteUrl) {
              result.fidelity.push({
                component: `knowledge:${src.name}`,
                status: 'needs-review',
                detail: 'SharePoint source has no site URL captured — cannot look up or create a connector for it.',
              });
              emitLog('warn', `    "${src.name}": no SharePoint site URL captured — needs manual review.`);
              continue;
            }
            try {
              const conn = await getKnowledgeConnector(appUserId, 'sharepoint', siteUrl);
              if (!conn) {
                result.fidelity.push({
                  component: `knowledge:${src.name}`,
                  status: 'needs-review',
                  detail: `No SharePoint connector configured for ${siteUrl} yet — set one up via POST /api/destination/sharepoint-connector, then re-run this migration.`,
                });
                emitLog('warn', `    "${src.name}": no connector configured yet for ${siteUrl} (POST /api/destination/sharepoint-connector).`);
                continue;
              }
              if (conn.status === 'failed') {
                result.fidelity.push({
                  component: `knowledge:${src.name}`,
                  status: 'lost',
                  detail: `SharePoint connector setup for ${siteUrl} failed: ${conn.error ?? 'unknown error'}.`,
                });
                emitLog('warn', `    "${src.name}": connector for ${siteUrl} failed — ${conn.error ?? 'unknown error'}.`);
                continue;
              }

              let dataStoreIds = conn.dataStoreIds;
              if (conn.status === 'pending') {
                if (!conn.operationName) {
                  result.fidelity.push({
                    component: `knowledge:${src.name}`,
                    status: 'needs-review',
                    detail: `SharePoint connector for ${siteUrl} has no operation to poll (collection "${conn.collectionId}") — re-run once setup completes.`,
                  });
                  emitLog('warn', `    "${src.name}": connector for ${siteUrl} has no operation to poll.`);
                  continue;
                }
                const op = await getConnectorOperation(saToken, conn.operationName);
                // Resolved outcome, driven by the operation check UNLESS it
                // fails, in which case the realtimeState fallback below
                // resolves these instead — never reuse op.done/op.error
                // directly after that fallback runs, since they'd still
                // reflect the stale CHECK failure, not the connector's
                // actual state.
                let opDone = op.done;
                let opError = op.error;

                if (op.checkFailed) {
                  // The LRO record itself may be gone (confirmed live —
                  // Google 404s old operations). Fall back to the connector's
                  // own realtimeState on the Collection resource before
                  // giving up — durable ground truth instead of a possibly-
                  // expired operation record.
                  const discovered = await getConnectorDataStores(dest.project, 'global', saToken, conn.collectionId);
                  // A real dataStoreId is direct, definitive proof the
                  // connector finished — realtimeState came back undefined in
                  // practice (confirmed live), so trust the stronger signal.
                  if (discovered.dataStoreIds.length || discovered.realtimeState === 'ACTIVE') {
                    opDone = true;
                    opError = undefined;
                    if (discovered.dataStoreIds.length) dataStoreIds = discovered.dataStoreIds;
                  } else if (discovered.realtimeState === 'FAILED' || discovered.realtimeState === 'INITIALIZATION_FAILED') {
                    opDone = true;
                    opError = `connector state: ${discovered.realtimeState}`;
                  } else {
                    // Still genuinely unknown either way — never collapse a
                    // real check failure into the same message as normal
                    // provisioning, or a real problem hides behind an endless
                    // "still provisioning" note nobody investigates.
                    result.fidelity.push({
                      component: `knowledge:${src.name}`,
                      status: 'needs-review',
                      detail: `Could not confirm SharePoint connector status for ${siteUrl}: ${op.error ?? 'unknown error'} — re-run to check again.`,
                    });
                    emitLog('warn', `    "${src.name}": connector status check failed for ${siteUrl} — ${op.error ?? 'unknown error'}.`);
                    continue;
                  }
                }
                if (!opDone) {
                  result.fidelity.push({
                    component: `knowledge:${src.name}`,
                    status: 'needs-review',
                    detail: `SharePoint connector for ${siteUrl} is still provisioning (collection "${conn.collectionId}") — re-run once it completes.`,
                  });
                  emitLog('warn', `    "${src.name}": connector for ${siteUrl} still provisioning.`);
                  continue;
                }
                const status = opError ? 'failed' : 'done';
                if (status === 'done' && !dataStoreIds?.length) {
                  const discovered = await getConnectorDataStores(dest.project, 'global', saToken, conn.collectionId);
                  dataStoreIds = discovered.dataStoreIds;
                }
                await markKnowledgeConnectorStatus(appUserId, 'sharepoint', siteUrl, { status, error: opError, dataStoreIds });
                if (status === 'failed') {
                  result.fidelity.push({
                    component: `knowledge:${src.name}`,
                    status: 'lost',
                    detail: `SharePoint connector setup for ${siteUrl} failed: ${opError ?? 'unknown error'}.`,
                  });
                  emitLog('warn', `    "${src.name}": connector for ${siteUrl} failed — ${opError ?? 'unknown error'}.`);
                  continue;
                }
              }

              if (!dataStoreIds || !dataStoreIds.length) {
                result.fidelity.push({
                  component: `knowledge:${src.name}`,
                  status: 'needs-review',
                  detail: `SharePoint connector for ${siteUrl} finished provisioning but no data store was discoverable yet — verify in Cloud Console.`,
                });
                emitLog('warn', `    "${src.name}": connector for ${siteUrl} done but no data store discovered.`);
                continue;
              }

              let attached = 0;
              let failedAttach = 0;
              for (const dsId of dataStoreIds) {
                const attach = await attachDataStoreToEngine(dest, saToken, dsId);
                if (attach.ok) attached++;
                else failedAttach++;
              }
              if (attached && !failedAttach) {
                // 'partial', not 'mapped': Gemini Enterprise data-store attach
                // is ENGINE-WIDE (confirmed against Google's own schema —
                // Engine.dataStoreIds — and the docs' "an app must be
                // connected to a data store"), unlike agentFiles which are
                // genuinely per-agent. Every other agent sharing this engine
                // gains access to this site too, even if it never referenced
                // it in Copilot — a real fidelity gap from the source's
                // per-agent scoping, not a clean 1:1 migration. Surface it so
                // it lands in the report's "Needs human review" section
                // instead of reading as unqualified success.
                result.fidelity.push({
                  component: `knowledge:${src.name}`,
                  status: 'partial',
                  detail: `SharePoint site ${siteUrl} reconnected via Gemini's native connector and attached to the agent's engine. Caveat: this attachment is engine-wide in Gemini Enterprise — every other agent sharing the same engine can also search this site, even if it never referenced it in Copilot Studio. Review whether agents needing separate access should be split across engines.`,
                });
                emitLog('ok', `    "${src.name}": SharePoint connector for ${siteUrl} attached (${attached} data store(s)) — engine-wide visibility, see fidelity report.`);
              } else if (attached) {
                result.fidelity.push({
                  component: `knowledge:${src.name}`,
                  status: 'partial',
                  detail: `SharePoint site ${siteUrl}: ${attached}/${dataStoreIds.length} data store(s) attached, ${failedAttach} failed.`,
                });
                emitLog('warn', `    "${src.name}": SharePoint connector for ${siteUrl} partially attached (${attached}/${dataStoreIds.length}).`);
              } else {
                result.fidelity.push({
                  component: `knowledge:${src.name}`,
                  status: 'lost',
                  detail: `SharePoint site ${siteUrl}: connector data store(s) exist but attaching to the engine failed.`,
                });
                emitLog('warn', `    "${src.name}": SharePoint connector for ${siteUrl} exists but attach-to-engine failed.`);
              }
            } catch (e) {
              result.fidelity.push({
                component: `knowledge:${src.name}`,
                status: 'needs-review',
                detail: `Error while processing the SharePoint connector for ${siteUrl}: ${(e as Error).message}`,
              });
              emitLog('warn', `    "${src.name}": SharePoint connector error — ${(e as Error).message}`);
            }
          }

          if (other.length) {
            emitLog(
              'warn',
              `    ${other.length} knowledge source(s) NOT migrated (needs a connector or manual step): ` +
                other.map((k) => `${k.name}→${k.classification?.strategy ?? 'unclassified'}`).join(', '),
            );
            // FederatedStructuredSearchSource sources get their own fidelity note
            // from the search-assisted resolution block below — only push a note
            // here for the rest, so nothing is silently log-only AND nothing is
            // double-reported.
            for (const k of other.filter((s) => s.kind !== 'FederatedStructuredSearchSource')) {
              result.fidelity.push({
                component: `knowledge:${k.name}`,
                status: 'needs-review',
                detail: `Not migrated — strategy "${k.classification?.strategy ?? 'unclassified'}" (target: ${k.classification?.geminiTarget ?? 'none'}) has no automatic path yet; raw config preserved for manual review.`,
              });
            }
          }

          // Search-assisted resolution for "upload and sync" SharePoint/OneDrive
          // sources (FederatedStructuredSearchSource — no auto-discoverable URL;
          // see .claude/memory/decisions.md). A filename search can return
          // several look-alike files (confirmed against real data — 10
          // same-named matches in one test) — ambiguous results always wait for
          // a person to confirm via POST /api/migrate/knowledge-source-confirm.
          // But when the search comes back with EXACTLY ONE candidate there is
          // nothing left to disambiguate, so it's downloaded and attached
          // automatically — recorded in the fidelity report as an automatic
          // match, not a silent one.
          const searchable = other.filter((k) => k.kind === 'FederatedStructuredSearchSource');
          for (const src of searchable) {
            try {
              let scopedToUser: string | null = null;
              if (src.metadata?.modifiedByUserId) {
                const dvToken = await tokenFor(row.envUrl);
                scopedToUser = await resolveSystemUserEmail(row.envUrl, dvToken, src.metadata.modifiedByUserId);
              }
              const candidates = await findCandidates(await graphToken(), src.name, {
                oneDriveOwnerEmail: scopedToUser ?? undefined,
              });

              // Graph's /search(q=...) is Microsoft Search — relevance/full-text
              // across content AND metadata, NOT a strict filename-equals match.
              // A lone hit is only trustworthy if its name actually resembles
              // what we searched for; otherwise "exactly 1 result" can still be
              // an unrelated file that merely ranked as the sole relevant match
              // (confirmed against real data: searching "TestingPermissions" — a
              // FOLDER name, not a file — returned one unrelated document whose
              // content happened to be relevant, not a file named that).
              if (candidates.length === 1 && isPlausibleFilenameMatch(src.name, candidates[0].name)) {
                const only = candidates[0];
                const attach = await migrateSharePointDriveItem(dest, saToken, await graphToken(), create.agentId, only, false);
                if (attach.succeeded) {
                  result.knowledgeFilesUploaded = (result.knowledgeFilesUploaded ?? 0) + 1;
                  result.fidelity.push({
                    component: `knowledge:${src.name}`,
                    status: 'mapped',
                    detail: `Matched automatically via Microsoft Graph filename search (single candidate: "${only.name}"${scopedToUser ? ` in ${scopedToUser}'s OneDrive` : ''}) — confidence: high (unique match).`,
                  });
                  emitLog('ok', `    "${src.name}": 1 unique candidate found — downloaded and attached automatically as "${only.name}".`);
                } else if (attach.alreadyAttached) {
                  emitLog('ok', `    "${src.name}": unique candidate "${only.name}" already attached — skipped.`);
                } else {
                  result.knowledgeFilesFailed = (result.knowledgeFilesFailed ?? 0) + 1;
                  result.knowledgeSourceCandidates = result.knowledgeSourceCandidates ?? [];
                  result.knowledgeSourceCandidates.push({ sourceName: src.name, scopedToUser, candidates });
                  emitLog('warn', `    "${src.name}": found 1 candidate but auto-attach failed — ${attach.error}. Confirm manually via POST /api/migrate/knowledge-source-confirm.`);
                }
                continue;
              }

              result.knowledgeSourceCandidates = result.knowledgeSourceCandidates ?? [];
              result.knowledgeSourceCandidates.push({ sourceName: src.name, scopedToUser, candidates });
              let msg: string;
              if (candidates.length === 0) {
                msg = `    "${src.name}": search found no candidates${scopedToUser ? ` in ${scopedToUser}'s OneDrive` : ' (no owner identified — SharePoint site search not attempted without a known site)'}.`;
              } else if (candidates.length === 1) {
                msg = `    "${src.name}": found 1 result ("${candidates[0].name}") but its name doesn't resemble the source name — Graph's search matches content, not just filenames, so this could be unrelated. Review and confirm via POST /api/migrate/knowledge-source-confirm (not auto-attached).`;
              } else {
                msg = `    "${src.name}": found ${candidates.length} candidate(s)${scopedToUser ? ` in ${scopedToUser}'s OneDrive` : ''} — ambiguous, review and confirm via POST /api/migrate/knowledge-source-confirm (not auto-attached).`;
              }
              emitLog('warn', msg);
            } catch (e) {
              emitLog('warn', `    "${src.name}": candidate search failed — ${(e as Error).message}`);
            }
          }
        }

        if (usedAdk) {
          // ADK/Agent Engine agents are created ENABLED (deployed) and
          // ALL_USERS-shared automatically at registration — confirmed live
          // 2026-07-31 (registered agent already showed sharingConfig.scope:
          // "ALL_USERS" with no separate call). The low-code publish/share
          // REST calls below are for lowCodeAgentDefinition agents specifically
          // and are skipped here rather than called speculatively/untested.
          result.deployed = true;
          result.shared = true;
        } else {
          // Mirror the source agent's publish state instead of force-publishing
          // every migration: a bot never published in Copilot Studio (still a
          // Draft) stays a Draft in Gemini too.
          const sourceWasDraft = !row.mapped.ir.sourceMetadata?.lastPublished;
          if (sourceWasDraft) {
            result.deployed = false;
            result.draftPreserved = true;
            result.fidelity.push({
              component: 'status',
              status: 'mapped',
              detail: 'Source agent was never published in Copilot Studio (Draft) — left as Draft in Gemini to mirror source status.',
            });
          } else {
            result.deployed = await publishAgent(dest, saToken, create.agentId);
          }
          result.shared = await shareAgent(dest, saToken, create.agentId);
        }
        const v = await verifyAgent(dest, saToken, create.agentId);
        result.verified = v.verified;
        result.verifySample = v.sample;
        await markStaged(runId, row.sourceId, {
          status: 'inserted',
          geminiAgentId: create.agentId,
          deployed: result.deployed,
          draftPreserved: result.draftPreserved,
          shared: result.shared,
          verified: v.verified,
          verifySample: v.sample,
        });
        emitLog(
          'ok',
          `  ${row.name} → ${dest.engine}/${create.agentId} · deployed=${result.deployed}${result.draftPreserved ? ' (draft preserved)' : ''} shared=${result.shared} verified=${result.verified}`,
        );
      }
    } catch (err) {
      result.error = (err as Error).message;
      await markStaged(runId, row.sourceId, { status: 'failed', error: result.error });
      emitLog('fail', `  ${row.name}: ${result.error}`);
      logger.error({ err, bot: row.name }, 'agent insert failed');
    } finally {
      results.push(result);
      void saveResult(runId, appUserId, result);
      emit({ type: 'agent', result });
      inserted++;
      emitProg(50 + Math.round(48 * (inserted / staged.length)), `Inserting ${inserted}/${staged.length}`);
    }
  });

  const created = results.filter((r) => r.created).length;
  const deployed = results.filter((r) => r.deployed).length;
  const shared = results.filter((r) => r.shared).length;
  const verified = results.filter((r) => r.verified).length;

  let summary = `${created}/${total} created · ${deployed} deployed · ${shared} shared · ${verified} verified`;

  if (quotaExhausted) {
    // Daily agent-creation cap hit: the remaining staged agents are untouched in
    // the DB. Record WHEN they can resume (next midnight-PT reset) so a scheduler
    // can re-run the insert phase unattended. finishRun uses 'paused-quota' (not
    // 'done') so the run is discoverable as resumable.
    const resumeAfter = nextQuotaResetUtc().toISOString();
    const pending = staged.length - created;
    summary += ` · PAUSED on agent-creation quota — ${pending} agent(s) will resume after ${resumeAfter}`;
    emitLog('warn', `Migration paused: daily agent-creation quota reached. ${pending} agent(s) remain staged; they resume automatically after the reset (${resumeAfter}). No re-extraction needed.`);
    await finishRun(runId, summary, 'paused-quota');
    emitProg(100, 'Paused on quota — resumes after daily reset');
    emit({ type: 'done', summary, results });
    return;
  }

  await finishRun(runId, summary);
  emitProg(100, 'Migration complete');
  emit({ type: 'done', summary, results });
}
