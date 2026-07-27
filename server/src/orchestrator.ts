import { config } from './config.js';
import { clientCredsToken } from './auth/microsoft.js';
import { getSaToken, serviceAccountEmail } from './auth/google.js';
import { logger } from './logger.js';
import { extractAgent, fetchFileAttachmentBytes } from './services/dataverse.js';
import { buildOrganizationProfile } from './services/organizationProfile.js';
import { createAgent, defaultDestination, resolveDestination, projectReachable, publishAgent, shareAgent } from './services/gemini.js';
import { uploadAgentFile, updateAgentFiles, getAgent, readAgentFiles, mimeTypeForFile, type AgentFile } from './services/geminiAgentFiles.js';
import { mapAgent } from './services/mapper.js';
import { planTopicsMigration } from './services/topicsMigration.js';
import { verifyAgent } from './services/verify.js';
import { preflightQuota, nextQuotaResetUtc } from './services/quota.js';
import { DEFAULT_APP_USER_ID, newId, type Session } from './sessionStore.js';
import { appendLog, finishRun, saveResult, startRun } from './db/repos/migrations.js';
import { cacheAgentIR } from './db/repos/agentIR.js';
import { listStaged, markStaged, stageAgent } from './db/repos/staged.js';
import type { AgentIR, GeminiDestination, MigrationResult, ProgressEvent, ResolvedPlan } from './types.js';

/**
 * Migrate an agent's uploaded knowledge files (Copilot Bot File Attachments)
 * into the Gemini agent's `agentFiles`: fetch bytes from Dataverse → upload via
 * files:upload → attach via UpdateAgent. Runs after the agent exists (files are
 * a sub-resource of the agent). Non-file sources (websites, Dataverse) are
 * handled separately. Never throws — reports counts.
 */
async function attachKnowledgeFiles(
  dest: GeminiDestination,
  saToken: string,
  agentId: string,
  ir: AgentIR,
  envUrl: string,
  dvToken: string,
): Promise<{ uploaded: number; failed: number; skipped: number }> {
  const files = ir.knowledgeSources.filter((k) => k.kind === 'FileUpload' && k.file?.name);
  if (!files.length) return { uploaded: 0, failed: 0, skipped: 0 };

  // Idempotent: skip files already attached (by filename) so re-migration never
  // stacks duplicates — enterprise runs must be safely repeatable.
  const existing = readAgentFiles(await getAgent(dest, saToken, agentId));
  const existingNames = new Set(existing.map((f) => f.fileName));

  const refs: AgentFile[] = [];
  let failed = 0;
  let skipped = 0;
  for (const k of files) {
    const name = k.file!.name!;
    if (existingNames.has(name)) { skipped++; continue; } // already on the agent
    if (k.file?.compatible === false) { skipped++; continue; } // fails Gemini's ingest gate
    const got = await fetchFileAttachmentBytes(envUrl, dvToken, k.id);
    if (!got) { failed++; continue; }
    const up = await uploadAgentFile(dest, saToken, agentId, {
      fileName: name,
      mimeType: mimeTypeForFile(name, got.contentType),
      bytes: got.bytes,
    });
    const ref = up.ok ? (up.raw as { agentFile?: AgentFile }).agentFile : undefined;
    if (ref?.name) refs.push(ref);
    else failed++;
  }

  if (refs.length) {
    const merged = [...existing, ...refs];
    const res = await updateAgentFiles(dest, saToken, agentId, merged);
    if (!res.ok) return { uploaded: 0, failed: failed + refs.length, skipped };
  }
  return { uploaded: refs.length, failed, skipped };
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
      // The client grants OUR service account access one of two ways. Use
      // whichever they set up: DIRECT (SA added to their project IAM) or
      // IMPERSONATION (SA authorized in their Domain-Wide Delegation). Dev bypass
      // impersonates a fixed configured admin.
      if (config.GOOGLE_AUTH_MODE === 'bypass') {
        saToken = await getSaToken(config.GOOGLE_IMPERSONATE_EMAIL || gEmail || undefined);
        emitLog('ok', `Service account token acquired (bypass, as ${config.GOOGLE_IMPERSONATE_EMAIL || gEmail})`);
      } else {
        const direct = await getSaToken(); // SA's own identity (client granted IAM)
        if (project && (await projectReachable(project, direct))) {
          saToken = direct;
          emitLog('ok', `Using CloudFuze service account (granted IAM on project ${project})`);
        } else if (gEmail) {
          saToken = await getSaToken(gEmail); // impersonate client admin (DWD)
          if (project && !(await projectReachable(project, saToken))) throw new Error('reachable-check-failed');
          emitLog('ok', `Using CloudFuze service account impersonating ${gEmail} (Domain-Wide Delegation)`);
        } else {
          throw new Error('no-access');
        }
      }
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

  // Build the organization profile once (single source of truth) — used to
  // recommend website data store vs. Google Search grounding per source.
  const orgProfile = await buildOrganizationProfile(session, new Date().toISOString());
  const ownerDomains = orgProfile.ownedDomains;
  if (ownerDomains.length) {
    emitLog('info', `Org profile: owned domains [${ownerDomains.join(', ')}] via ${orgProfile.domainSources.join(', ') || 'none'}`);
  }

  // ── PHASE 1 — EXTRACT → stage in DB (parallel, batched) ───────────────────
  emitLog('info', `── Phase 1: extract → stage in DB (${total} agents) ──`);
  let extracted = 0;
  await mapPool(workItems, CONCURRENCY, async (item) => {
    try {
      const token = await tokenFor(item.envUrl);
      const ir = await extractAgent(item.envUrl, token, item.bot, { ownerDomains });
      // Compile topics ONCE (Topic → Capability → Connected-Agent plan) and feed
      // it to the mapper so its procedures are folded into the instruction, and
      // stage a flat, queryable copy of the capabilities.
      const topicsPlan = planTopicsMigration(ir);
      const mapped = await mapAgent(ir, {
        unsupportedKnowledgeHandling: plan.knowledgeHandling ?? 'report-only',
        topicsPlan,
      });
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
      const create = await createAgent(dest, saToken, row.mapped);
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
        if (ks.some((k) => k.kind === 'FileUpload')) {
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
          } catch (e) {
            emitLog('warn', `    knowledge file migration error: ${(e as Error).message}`);
          }
        }
        const nonFile = ks.filter((k) => k.kind !== 'FileUpload' && k.classification?.automatable);
        if (nonFile.length) {
          emitLog(
            'warn',
            `    ${nonFile.length} non-file knowledge source(s) NOT migrated (data-store path not yet wired): ` +
              nonFile.map((k) => `${k.name}→${k.classification?.strategy}`).join(', '),
          );
        }

        result.deployed = await publishAgent(dest, saToken, create.agentId);
        result.shared = await shareAgent(dest, saToken, create.agentId);
        const v = await verifyAgent(dest, saToken, create.agentId);
        result.verified = v.verified;
        result.verifySample = v.sample;
        await markStaged(runId, row.sourceId, {
          status: 'inserted',
          geminiAgentId: create.agentId,
          deployed: result.deployed,
          shared: result.shared,
          verified: v.verified,
          verifySample: v.sample,
        });
        emitLog(
          'ok',
          `  ${row.name} → ${dest.engine}/${create.agentId} · deployed=${result.deployed} shared=${result.shared} verified=${result.verified}`,
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
