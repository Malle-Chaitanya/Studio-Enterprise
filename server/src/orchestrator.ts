import { clientCredsToken } from './auth/microsoft.js';
import { getSaToken, serviceAccountEmail } from './auth/google.js';
import { logger } from './logger.js';
import { extractAgent, fetchFileAttachmentBytes, resolveSystemUserEmail } from './services/dataverse.js';
import { findCandidates } from './services/graphSearch.js';
import { resolveShareUrlSmart, downloadDriveItemBytes } from './services/graphFiles.js';
import { buildOrganizationProfile } from './services/organizationProfile.js';
import { createAgent, defaultDestination, resolveDestination, projectReachable, publishAgent, shareAgent, grantAgentAccess, effectiveGeminiProject, type CreateOutcome } from './services/gemini.js';
import { listConnectorCredentials } from './db/repos/connectorCredentials.js';
import { uploadAgentFile, updateAgentFiles, getAgent, readAgentFiles, mimeTypeForFile, type AgentFile } from './services/geminiAgentFiles.js';
import { mapAgent } from './services/mapper.js';
import { resolveConnectorSecrets, buildLiveConnectorSpecsDetailed, agentConnectorIds } from './services/connectorToolBuilder.js';
import { connectorsSharingCredentials } from './services/connectorCredentials.js';
import { readinessFor } from './connectors/readiness.js';
import { buildBoundToolSpecs } from './connectors/boundToolSpec.js';
import type { CaptureContext } from './connectors/captureOpIndex.js';
import { REGISTRY_BY_ID } from './connectors/registry.js';
import { needsAclAcknowledgement, aclDisclosureFor, aclDisclosureSummary } from './services/aclDisclosure.js';
import { migrateSharePointToDataStore } from './services/sharePointMigrator.js';
import type { SharePointMigrationResult } from './services/sharePointMigrator.js';
import { migrateConfluenceToDataStore, type ConfluenceCreds, type ConfluenceMigrationResult } from './services/confluenceMigrator.js';
import {
  migrateDataverseSnapshot,
  migrateSharePointDriveItem,
  migrateFileToDocumentStore,
  type DataverseSnapshotResult,
} from './services/knowledgeDataStoreExecutor.js';
import { attachDataStoreToEngine, dataStoreExists, dataStoreResourcePath } from './services/geminiDataStore.js';
import { getConnectorOperation, getConnectorDataStores } from './services/geminiConnector.js';
import { getKnowledgeConnector, markKnowledgeConnectorStatus } from './db/repos/knowledgeConnectors.js';
import { firstWebsiteSource, publishAgentToGallery } from './services/adkDeployer.js';
import { getAdkDeployment, recordAdkDeployment } from './db/repos/adkDeployments.js';
import { getMigratedSnapshot, saveMigratedSnapshot } from './db/repos/migratedSnapshot.js';
import { snapshotFrom, detectDrift } from './services/driftDetector.js';
import { getAdkKnowledgeStore, upsertAdkKnowledgeStore } from './db/repos/adkKnowledgeStores.js';
import { schedulePendingGroundingRecheck } from './db/repos/pendingGroundingRechecks.js';
import { planTopicsMigration } from './services/topicsMigration.js';
import { normalizeSharePointSiteUrl } from './services/knowledgePlanner.js';
import { verifyAgent } from './services/verify.js';
import { preflightQuota, nextQuotaResetUtc } from './services/quota.js';
import { DEFAULT_APP_USER_ID, credentialScope, newId, type Session } from './sessionStore.js';
import { appendLog, finishRun, saveResult, startRun } from './db/repos/migrations.js';
import { cacheAgentIR } from './db/repos/agentIR.js';
import { listStaged, markStaged, stageAgent } from './db/repos/staged.js';
import { getIdentityMap } from './db/repos/identityMap.js';
import {
  buildPermissionHandoff,
  isOrgWideChat,
  permissionFidelityNotes,
  resolvePermissions,
} from './services/identityMap.js';
import type { AgentIR, FidelityNote, GeminiDestination, IdentityMapOverrides, KnowledgeSourceIR, MigrationResult, ProgressEvent, ResolvedPlan } from './types.js';

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

interface DataverseSnapshotResolution {
  src: KnowledgeSourceIR;
  snap: DataverseSnapshotResult;
}

interface SharePointConnectorResolution {
  src: KnowledgeSourceIR;
  siteUrl: string;
  dataStoreIds: string[];
}

/**
 * Resolve every dataverse-snapshot knowledge source into a built, importable
 * Discovery Engine data store — BEFORE the low-code/ADK decision, so the SAME
 * resolved store can be attached engine-wide (low-code) or baked into
 * VertexAiSearchTool (ADK) instead of only ever reaching the low-code path.
 * Naming key is the stable Copilot botid (`sourceId`), not the destination
 * agent id — the agent doesn't exist yet at this point.
 */
async function resolveDataverseSnapshotSources(
  dest: GeminiDestination,
  saToken: string,
  dvToken: string,
  envUrl: string,
  sourceId: string,
  sources: KnowledgeSourceIR[],
): Promise<DataverseSnapshotResolution[]> {
  const out: DataverseSnapshotResolution[] = [];
  for (const src of sources) {
    // Table resolution lives in the executor now: resolveTableSearchTarget follows the
    // real Dataverse join (`dvtablesearch` → `dvtablesearchentity` → `entitylogicalname`)
    // rather than matching the captured key against table DISPLAY names, which could
    // never match — that key is an arbitrary generated name, and treating it as an
    // EntitySetName is why every table-search source failed with a misleading
    // "EntityDefinitions lookup failed" (confirmed live 2026-08-07).
    //
    // KNOWN REGRESSION, deliberately taken: an earlier display-name resolver expanded ONE
    // Copilot source naming SEVERAL tables ("FAQ Entry, CF ICP Profile") into one data
    // store each, because different schemas cannot share a structured store. The correct
    // resolver reads only the FIRST `dvtablesearchentity` row, so a multi-table source now
    // snapshots one table. Correct-but-narrow beats broad-but-broken; fixing it properly
    // means returning every entity from that join, not going back to display names.
    const snap = await migrateDataverseSnapshot(dest, saToken, dvToken, envUrl, sourceId, src);
    out.push({ src, snap });
  }
  return out;
}

interface SharePointCopyModeResolution {
  src: KnowledgeSourceIR;
  resourcePath: string;
  dataStoreId: string;
  fileName: string;
}

/**
 * Copy-mode fallback for SharePoint sources, tried BEFORE the native
 * connector (resolveSharePointConnectorSources below).
 *
 * ⚠️ CONFIRMED 2026-08-06: Gemini's native SharePoint connector (federated OR
 * data-ingestion, both with fully correct OAuth/auth) reliably returns ZERO
 * content — see knowledgeClassifier.ts's module docstring for the full
 * evidence trail. Escalated to Google Cloud Support; not yet fixed on
 * Google's side. Until it is, any SharePoint source that resolves to ONE
 * specific file is downloaded directly via Microsoft Graph (the SAME
 * app-only credentials already used for Dataverse extraction — no new
 * customer-side setup) and grounded exactly like a locally-uploaded file
 * (migrateFileToDocumentStore) — proven working end-to-end live 2026-08-06.
 *
 * Only handles the single-file case. A source that resolves to a folder,
 * whole site, or multiple ambiguous candidates is left in `remaining` for
 * the native-connector path to attempt (which, per the above, is not
 * currently expected to work either — but there is no other automated
 * option yet for a whole-site/library reference).
 */
async function resolveSharePointCopyModeSources(
  project: string,
  saToken: string,
  graphToken: string,
  agentSourceId: string,
  sources: KnowledgeSourceIR[],
): Promise<{
  resolved: SharePointCopyModeResolution[];
  remaining: KnowledgeSourceIR[];
  logs: { level: 'info' | 'ok' | 'warn' | 'fail'; text: string }[];
}> {
  const resolved: SharePointCopyModeResolution[] = [];
  const remaining: KnowledgeSourceIR[] = [];
  const logs: { level: 'info' | 'ok' | 'warn' | 'fail'; text: string }[] = [];

  for (const src of sources) {
    const url = (src.reference ?? src.references?.[0] ?? '').trim();
    // Some knowledge sources (confirmed live 2026-08-07: Copilot Studio's
    // FederatedStructuredSearchSource with an opaque skillConfiguration id,
    // see knowledgeClassifier.ts) capture an internal config-record name, not
    // a real URL — encoding that as a Graph "share id" is guaranteed to 400.
    // Skip straight to the native-connector fallback instead of wasting the
    // call and logging a scary, misleading failure.
    if (!url || !/^https?:\/\//i.test(url)) {
      remaining.push(src);
      continue;
    }
    try {
      const shared = await resolveShareUrlSmart(graphToken, url);
      // 'file' and 'folder-single-file' are BOTH a confident single-item
      // match (see graphFiles.ts's resolveShareUrlSmart) — only
      // 'folder-multiple-files' (real ambiguity) and 'not-found' fall through
      // to the native-connector attempt below.
      if ((shared.kind !== 'file' && shared.kind !== 'folder-single-file') || !shared.item) {
        remaining.push(src);
        continue;
      }
      const bytes = await downloadDriveItemBytes(graphToken, shared.item);
      if (!bytes) {
        remaining.push(src);
        logs.push({ level: 'warn', text: `    "${src.name}": resolved to "${shared.item.name}" but downloading its content failed — falling back to the native connector attempt.` });
        continue;
      }
      const up = await migrateFileToDocumentStore(project, saToken, agentSourceId, {
        name: shared.item.name,
        bytes: bytes.bytes,
        mimeType: bytes.contentType || 'application/octet-stream',
      });
      if (!up.resourcePath || !up.dataStoreId) {
        remaining.push(src);
        logs.push({ level: 'warn', text: `    "${src.name}": copy-mode grounding failed (${up.error ?? 'unknown error'}) — falling back to the native connector attempt.` });
        continue;
      }
      resolved.push({ src, resourcePath: up.resourcePath, dataStoreId: up.dataStoreId, fileName: shared.item.name });
      logs.push({
        level: 'ok',
        text: `    "${src.name}": Gemini's native SharePoint connector is confirmed broken (see knowledgeClassifier.ts) — used copy mode instead, downloaded "${shared.item.name}" directly via Microsoft Graph and grounded it like an uploaded file.`,
      });
    } catch (e) {
      remaining.push(src);
      logs.push({ level: 'warn', text: `    "${src.name}": copy-mode resolution error — ${(e as Error).message}. Falling back to the native connector attempt.` });
    }
  }
  return { resolved, remaining, logs };
}

/**
 * Resolve every sharepoint-connector knowledge source into ready-to-use
 * Discovery Engine data store ids — BEFORE the low-code/ADK decision, same
 * reasoning as resolveDataverseSnapshotSources above. Every "not ready yet"
 * outcome (no URL captured / not configured / still provisioning / failed) is
 * path-independent — nothing was built either way — so those FidelityNotes
 * are returned immediately; only resolved entries need a path-specific attach
 * step afterward (engine-wide attach for low-code, VertexAiSearchTool for ADK).
 */
async function resolveSharePointConnectorSources(
  appUserId: string,
  dest: GeminiDestination,
  saToken: string,
  sources: KnowledgeSourceIR[],
): Promise<{
  resolved: SharePointConnectorResolution[];
  notes: FidelityNote[];
  logs: { level: 'info' | 'ok' | 'warn' | 'fail'; text: string }[];
}> {
  const resolved: SharePointConnectorResolution[] = [];
  const notes: FidelityNote[] = [];
  const logs: { level: 'info' | 'ok' | 'warn' | 'fail'; text: string }[] = [];

  for (const src of sources) {
    const siteUrlRaw = (src.reference ?? src.references?.[0] ?? '').trim();
    // normalizeSharePointSiteUrl's catch branch passes non-URL input through
    // unchanged (by design, for callers that already validated a real URL) —
    // guard here so an opaque config-record id (see the copy-mode resolver's
    // comment above) isn't silently used as a connector "site key", which
    // produces a confusing "connector done but no data store discovered"
    // instead of an honest "not a URL" note.
    const looksLikeUrl = /^https?:\/\//i.test(siteUrlRaw);
    const siteUrl = looksLikeUrl ? normalizeSharePointSiteUrl(siteUrlRaw) : '';
    if (!siteUrl) {
      notes.push({
        component: `knowledge:${src.name}`,
        status: 'needs-review',
        detail: siteUrlRaw
          ? `SharePoint source has no resolvable site URL — the captured reference ("${siteUrlRaw}") is an internal Copilot Studio config id, not a URL. Verify the actual site/file in Copilot Studio's Knowledge Details screen, then set up the connector manually via POST /api/destination/sharepoint-connector.`
          : 'SharePoint source has no site URL captured — cannot look up or create a connector for it.',
      });
      logs.push({
        level: 'warn',
        text: `    "${src.name}": ${siteUrlRaw ? 'captured reference is not a resolvable URL' : 'no SharePoint site URL captured'} — needs manual review.`,
      });
      continue;
    }
    try {
      // Prefer normalized site key; also try the raw file URL for older connector rows.
      const conn =
        (await getKnowledgeConnector(appUserId, 'sharepoint', siteUrl)) ??
        (siteUrlRaw !== siteUrl ? await getKnowledgeConnector(appUserId, 'sharepoint', siteUrlRaw) : null);
      if (!conn) {
        notes.push({
          component: `knowledge:${src.name}`,
          status: 'needs-review',
          detail: `No SharePoint connector configured for ${siteUrl} yet — set one up via POST /api/destination/sharepoint-connector, then re-run this migration.`,
        });
        logs.push({ level: 'warn', text: `    "${src.name}": no connector configured yet for ${siteUrl} (POST /api/destination/sharepoint-connector).` });
        continue;
      }
      if (conn.status === 'failed') {
        notes.push({
          component: `knowledge:${src.name}`,
          status: 'lost',
          detail: `SharePoint connector setup for ${siteUrl} failed: ${conn.error ?? 'unknown error'}.`,
        });
        logs.push({ level: 'warn', text: `    "${src.name}": connector for ${siteUrl} failed — ${conn.error ?? 'unknown error'}.` });
        continue;
      }

      let dataStoreIds = conn.dataStoreIds;
      if (conn.status === 'pending') {
        if (!conn.operationName) {
          notes.push({
            component: `knowledge:${src.name}`,
            status: 'needs-review',
            detail: `SharePoint connector for ${siteUrl} has no operation to poll (collection "${conn.collectionId}") — re-run once setup completes.`,
          });
          logs.push({ level: 'warn', text: `    "${src.name}": connector for ${siteUrl} has no operation to poll.` });
          continue;
        }
        const op = await getConnectorOperation(saToken, conn.operationName);
        // Resolved outcome, driven by the operation check UNLESS it fails, in
        // which case the realtimeState fallback below resolves these instead.
        let opDone = op.done;
        let opError = op.error;

        if (op.checkFailed) {
          const discovered = await getConnectorDataStores(dest.project, 'global', saToken, conn.collectionId);
          if (discovered.dataStoreIds.length || discovered.realtimeState === 'ACTIVE') {
            opDone = true;
            opError = undefined;
            if (discovered.dataStoreIds.length) dataStoreIds = discovered.dataStoreIds;
          } else if (discovered.realtimeState === 'FAILED' || discovered.realtimeState === 'INITIALIZATION_FAILED') {
            opDone = true;
            opError = `connector state: ${discovered.realtimeState}`;
          } else {
            notes.push({
              component: `knowledge:${src.name}`,
              status: 'needs-review',
              detail: `Could not confirm SharePoint connector status for ${siteUrl}: ${op.error ?? 'unknown error'} — re-run to check again.`,
            });
            logs.push({ level: 'warn', text: `    "${src.name}": connector status check failed for ${siteUrl} — ${op.error ?? 'unknown error'}.` });
            continue;
          }
        }
        if (!opDone) {
          notes.push({
            component: `knowledge:${src.name}`,
            status: 'needs-review',
            detail: `SharePoint connector for ${siteUrl} is still provisioning (collection "${conn.collectionId}") — re-run once it completes.`,
          });
          logs.push({ level: 'warn', text: `    "${src.name}": connector for ${siteUrl} still provisioning.` });
          continue;
        }
        const status = opError ? 'failed' : 'done';
        if (status === 'done' && !dataStoreIds?.length) {
          const discovered = await getConnectorDataStores(dest.project, 'global', saToken, conn.collectionId);
          dataStoreIds = discovered.dataStoreIds;
        }
        await markKnowledgeConnectorStatus(appUserId, 'sharepoint', siteUrl, { status, error: opError, dataStoreIds });
        if (status === 'failed') {
          notes.push({
            component: `knowledge:${src.name}`,
            status: 'lost',
            detail: `SharePoint connector setup for ${siteUrl} failed: ${opError ?? 'unknown error'}.`,
          });
          logs.push({ level: 'warn', text: `    "${src.name}": connector for ${siteUrl} failed — ${opError ?? 'unknown error'}.` });
          continue;
        }
      }

      if (!dataStoreIds || !dataStoreIds.length) {
        notes.push({
          component: `knowledge:${src.name}`,
          status: 'needs-review',
          detail: `SharePoint connector for ${siteUrl} finished provisioning but no data store was discoverable yet — verify in Cloud Console.`,
        });
        logs.push({ level: 'warn', text: `    "${src.name}": connector for ${siteUrl} done but no data store discovered.` });
        continue;
      }

      // dataStoreIds above may be a CACHED value from a prior run's `done`
      // status (the `if (conn.status === 'pending')` branch never re-runs for
      // an already-done connector) — it is never re-verified against Google's
      // side. Confirmed live 2026-08-06: a store referenced here was deleted
      // out-of-band (manual Console cleanup) and this cache never noticed,
      // so the stale ID got baked straight into the ADK agent's grounding
      // tool, which then hard-crashed with a 404 on every query instead of
      // failing gracefully. Verify existence here, every run, same as the
      // FileUpload knowledge-health check in orchestrator's ADK skip logic.
      const liveDataStoreIds: string[] = [];
      const deadDataStoreIds: string[] = [];
      for (const id of dataStoreIds) {
        if (await dataStoreExists(dest.project, saToken, id)) liveDataStoreIds.push(id);
        else deadDataStoreIds.push(id);
      }
      if (deadDataStoreIds.length) {
        await markKnowledgeConnectorStatus(appUserId, 'sharepoint', siteUrl, { dataStoreIds: liveDataStoreIds });
        logs.push({
          level: 'warn',
          text: `    "${src.name}": connector data store(s) ${deadDataStoreIds.join(', ')} for ${siteUrl} no longer exist (deleted on the Google side) — dropping from grounding.`,
        });
      }
      if (!liveDataStoreIds.length) {
        notes.push({
          component: `knowledge:${src.name}`,
          status: 'lost',
          detail: `SharePoint connector data store(s) for ${siteUrl} were deleted on the Google side and no longer exist — re-run POST /api/destination/sharepoint-connector to recreate, then re-migrate this agent.`,
        });
        continue;
      }

      resolved.push({ src, siteUrl, dataStoreIds: liveDataStoreIds });
    } catch (e) {
      notes.push({
        component: `knowledge:${src.name}`,
        status: 'needs-review',
        detail: `Error while processing the SharePoint connector for ${siteUrl}: ${(e as Error).message}`,
      });
      logs.push({ level: 'warn', text: `    "${src.name}": SharePoint connector error — ${(e as Error).message}` });
    }
  }

  return { resolved, notes, logs };
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
  const identityOverrides: IdentityMapOverrides = await getIdentityMap(
    appUserId,
    session.tenantId ?? '',
  );
  const mappedUserCount = Object.keys(identityOverrides.users).length;
  const mappedGroupCount = Object.keys(identityOverrides.groups).length;
  if (mappedUserCount || mappedGroupCount) {
    emitLog('info', `Identity map: ${mappedUserCount} user override(s), ${mappedGroupCount} group override(s)`);
  }
  const allowOvershare = !!plan.destination.allowOvershare;

  // ── Resolve connector credentials once before extraction starts ──────────
  // Reads any third-party / MS-native API credentials the customer saved in
  // ConnectorConfig from Google Secret Manager, then embeds them in every
  // agent's instruction via buildConnectorInstructionBlock.
  // Connectors come from the DURABLE credential records, not only from the plan.
  //
  // plan.savedConnectors is a snapshot taken when the plan was built, so saving a
  // credential after that point had no effect: the run saw an empty list, wired no
  // tools, and reported the Confluence source as "needs a connector" while the
  // credentials sat correctly in Secret Manager (live 2026-08-07, twice). Nothing in
  // the UI suggested the plan had to be rebuilt afterwards.
  //
  // Only records stored in the project we are deploying INTO count — the container
  // resolves secrets from its own project, so a record from elsewhere is unusable.
  const destProject = effectiveGeminiProject(session.geminiProject);
  const durableConnectorRecords = (await listConnectorCredentials(appUserId).catch(() => []))
    .filter((c) => !!destProject && c.project === destProject);
  const durableConnectorIds = durableConnectorRecords.map((c) => c.connectorId);
  // The id each credential was ACTUALLY written under. Secret ids are tenant-scoped
  // now, but credentials saved before that scoping live under the old name and already
  // back deployed agents — recomputing would point a working agent at a secret that
  // does not exist, and every tool call would 403 at inference behind a green deploy.
  // Resolve connector definitions from the CUSTOMER'S own environment (their installed
  // connectors, their versions) rather than the fixtures captured in ours.
  const captureCtxFor = (envUrl: string): CaptureContext | undefined => {
    const envId = session.environments?.find(
      (e) => e.url.replace(/\/$/, '') === envUrl.replace(/\/$/, ''),
    )?.id;
    if (!envId || !session.tenantId) return undefined;
    return { tenantId: session.tenantId, environmentId: envId, scope: credentialScope(session) };
  };

  const secretIdOpts = {
    // The customer's isolation key, not the Mongo scope key: `appUserId` is 'default' for
    // everyone until sign-in is wired, and secret ids built from it collide across
    // customers. See credentialScope() in sessionStore.ts.
    ownerScope: credentialScope(session),
    storedSecretIds: Object.fromEntries(
      durableConnectorRecords.map((c) => [c.connectorId, c.secretIds ?? {}]),
    ),
  };
  // Connectors that SHARE a credential group with something the customer configured are
  // configured too — one Atlassian token is Confluence and Jira; one HubSpot private app
  // token is every HubSpot connector. Without this expansion an agent using a sibling id
  // (live: `shared_hubspotcrm` where the saved record says `shared_hubspotcrmv2`) got no
  // tool at all, and the report called it an unsupported connector rather than the
  // already-satisfied credential it actually was.
  const savedConnectors = [
    ...new Set([
      ...(plan.savedConnectors ?? []),
      ...durableConnectorIds,
      ...durableConnectorIds.flatMap((id) => connectorsSharingCredentials(id)),
    ]),
  ];
  if (durableConnectorIds.length && !(plan.savedConnectors ?? []).length) {
    emitLog('info', `Connectors from saved credentials: ${durableConnectorIds.join(', ')}`);
  }
  const resolvedConnectors = savedConnectors.length && session.geminiProject
    ? await resolveConnectorSecrets(saToken, session.geminiProject, savedConnectors, secretIdOpts).catch((err) => {
        logger.warn({ err }, 'orchestrator: connector secret resolution failed; continuing without connector context');
        return [];
      })
    : [];
  if (resolvedConnectors.length) {
    emitLog('info', `Connector credentials resolved: ${resolvedConnectors.map((c) => c.name).join(', ')}`);
  }

  // Live API tools for the ADK deployment. Built from the saved connector IDS and
  // the registry alone — deliberately NOT from resolvedConnectors, because these
  // specs travel into the deployment and must never carry a credential value. The
  // container reads each secret from Secret Manager on every tool call.
  const { specs: liveConnectorSpecs, unsupported: unsupportedConnectorIds } =
    buildLiveConnectorSpecsDetailed(savedConnectors, secretIdOpts);
  if (liveConnectorSpecs.length) {
    emitLog('info', `Live connector tools to wire: ${liveConnectorSpecs.map((c) => c.name).join(', ')}`);
  }
  // A connector we have no registry entry for cannot become a tool. Say so loudly here
  // and as a per-agent FidelityNote below — dropping it with only a server-log warning
  // shipped an agent that looked migrated while quietly missing a capability.
  if (unsupportedConnectorIds.length) {
    emitLog('warn', `No connector support for: ${unsupportedConnectorIds.join(', ')} — these tools will NOT be migrated`);
  }

  // Confluence connector creds (if the customer filled them in the Connectors step).
  // Used per-agent in Phase 2 to crawl only the spaces that specific agent selected.
  const confluenceConnector = resolvedConnectors.find((c) => c.connectorId === 'shared_confluence');

  // ── PHASE 1 — EXTRACT → stage in DB (parallel, batched) ───────────────────
  emitLog('info', `── Phase 1: extract → stage in DB (${total} agents) ──`);
  let extracted = 0;
  await mapPool(workItems, CONCURRENCY, async (item) => {
    try {
      const token = await tokenFor(item.envUrl);
      const ir = await extractAgent(item.envUrl, token, item.bot);
      // Compile topics ONCE (Topic → Capability → Connected-Agent plan) so a
      // flat, queryable copy of the capabilities can be staged. Topics are not
      // migrated in this phase, so the plan is not surfaced in the fidelity
      // report — see mapper.ts.
      const topicsPlan = planTopicsMigration(ir);
      // Scope the instruction's connector block to THIS agent too — the wired tools and
      // the text that describes them must agree, or the model is told about tools that
      // do not exist on it. Passing every configured connector gave an agent that
      // references three systems live API access to nine.
      const irConnectorIds = agentConnectorIds(ir);
      const mapped = await mapAgent(ir, {
        connectors: resolvedConnectors.filter((c) => irConnectorIds.has(c.connectorId)),
      });
      const capabilities = [...topicsPlan.systemCapabilities, ...topicsPlan.connectedAgents.flatMap((a) => a.capabilities)];

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

  const staged = await listStaged(appUserId, runId, 'staged');
  emitLog('info', `Phase 1 complete: ${staged.length}/${total} staged in DB`);

  // ── ACL-loss gate — the last honest moment before anything is written ──────
  //
  // Every data store this pipeline creates has `aclEnabled: false`, and that flag is
  // IMMUTABLE (proven live — docs/verification-ledger.md §1.3). So a SharePoint folder
  // restricted to Finance becomes readable by anyone who can reach the migrated agent, and
  // no later fix can change it: the store would have to be destroyed and re-indexed.
  //
  // The gate sits HERE, between the phases, on purpose. Extraction is read-only and cheap,
  // so by this point we can name the exact agents and sources at stake instead of warning
  // in the abstract — and because the rows are already staged, re-running after
  // acknowledgement skips straight to the insert.
  //
  // It does not block permanently. A hard refusal makes this tool look worse than a hand
  // migration and pushes people to disable the check; the decision
  // (docs/connector-transform-plan.md) is to migrate with a mandatory acknowledgement.
  const aclFlagged = staged
    .filter((row) => row.mapped && needsAclAcknowledgement(row.mapped.ir))
    .map((row) => ({ row, disclosure: aclDisclosureFor(row.mapped!.ir) }));

  // A dry run is never gated: it writes nothing, and it is exactly how someone discovers
  // this in the first place. It still reports every affected source, below.
  if (aclFlagged.length && !plan.acknowledgeAclLoss && !plan.dryRun) {
    emitLog('warn', `── Migration stopped: ${aclFlagged.length} agent(s) would lose source permissions ──`);
    for (const { row, disclosure } of aclFlagged) {
      emitLog('warn', `  ${aclDisclosureSummary(row.displayName, disclosure)}`);
      for (const item of disclosure.items) {
        emitLog('warn', `    • ${item.sourceName} (${item.system}, via ${item.strategy})`);
      }
      const result: MigrationResult = {
        sourceId: row.sourceId,
        name: row.name,
        created: false,
        deployed: false,
        shared: false,
        fidelity: [
          ...row.fidelity,
          ...disclosure.items.map((item) => ({
            component: `acl:${item.sourceName}`,
            status: 'needs-review' as const,
            detail: item.detail,
          })),
        ],
        error: 'acl_acknowledgement_required',
      };
      results.push(result);
      void saveResult(runId, appUserId, result);
      emit({ type: 'agent', result });
    }
    emitLog(
      'warn',
      'Nothing was created. Review the sources above; if this is acceptable, re-run with ' +
        '"I understand knowledge permissions will not be preserved" acknowledged. The staged ' +
        'agents are kept, so the re-run goes straight to the insert.',
    );
    emitProg(100, 'Stopped — permission loss needs acknowledgement');
    const summary = `Stopped · ${aclFlagged.length} agent(s) need a permission-loss acknowledgement before migrating`;
    await finishRun(runId, summary, 'done');
    emit({ type: 'done', summary, results });
    return;
  }

  // Acknowledged (or nothing to acknowledge). Record what was accepted on every affected
  // agent — an acknowledgement that leaves no trace in the report is worth nothing to the
  // person who reads that report six months from now.
  const aclNotesBySourceId = new Map<string, FidelityNote[]>();
  for (const { row, disclosure } of aclFlagged) {
    aclNotesBySourceId.set(
      row.sourceId,
      disclosure.items.map((item) => ({
        component: `acl:${item.sourceName}`,
        status: 'needs-review' as const,
        detail:
          `${item.detail} This was explicitly acknowledged before the migration ran. ` +
          `It cannot be changed without deleting and re-indexing the data store.`,
      })),
    );
  }
  if (aclFlagged.length) {
    emitLog(
      'warn',
      `Permission loss acknowledged for ${aclFlagged.length} agent(s) — proceeding. Each affected ` +
        'source is recorded in the fidelity report.',
    );
  }

  // ── Dry run: report what WOULD be inserted, stop before touching Gemini ────
  if (plan.dryRun) {
    for (const row of staged) {
      const result: MigrationResult = {
        sourceId: row.sourceId,
        name: row.name,
        created: false,
        deployed: false,
        shared: false,
        fidelity: [...row.fidelity, ...(aclNotesBySourceId.get(row.sourceId) ?? [])],
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
      // Acknowledged permission loss travels with the agent's own report, not just the run
      // log — the report is what someone reads months later.
      fidelity: [...row.fidelity, ...(aclNotesBySourceId.get(row.sourceId) ?? [])],
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

      // Resolve every knowledge source we already know how to ground into a
      // Discovery Engine data store BEFORE deciding low-code vs ADK, so
      // whichever path wins can actually use them — this is the fix for the
      // class of bug where an ADK-fallback agent reports a knowledge source as
      // "attached" but can never retrieve from it (attachDataStoreToEngine
      // only feeds the low-code path's engine-wide search; ADK's
      // VertexAiSearchTool needs the resource path baked in at deploy time).
      // Low-code and ADK need the SAME resolved stores; only how each attaches
      // them differs, decided further down once usedAdk is known.
      const ks = row.mapped.ir.knowledgeSources;
      const dvSnapshotSources = ks.filter((k) => k.kind !== 'FileUpload' && k.classification?.strategy === 'dataverse-snapshot');
      const spConnectorSources = ks.filter(
        (k) =>
          k.kind !== 'FileUpload' &&
          k.classification?.strategy !== 'dataverse-snapshot' &&
          k.classification?.geminiTarget === 'sharepoint-connector',
      );

      let dvResolved: DataverseSnapshotResolution[] = [];
      if (dvSnapshotSources.length) {
        const dvToken = await tokenFor(row.envUrl);
        dvResolved = await resolveDataverseSnapshotSources(dest, saToken, dvToken, row.envUrl, row.sourceId, dvSnapshotSources);
        for (const { src, snap } of dvResolved) {
          result.knowledgeTableRowsIndexed = (result.knowledgeTableRowsIndexed ?? 0) + snap.succeeded;
          result.knowledgeTableRowsFailed = (result.knowledgeTableRowsFailed ?? 0) + snap.failed;
          const via = snap.viaBigQuery ? ' (via BigQuery)' : '';
          emitLog(
            snap.error || snap.failed ? 'warn' : 'ok',
            `    Dataverse snapshot "${src.name}"${via}: ${snap.succeeded}/${snap.attempted} row(s) indexed` +
              (snap.failed ? `, ${snap.failed} failed` : '') +
              (snap.error ? ` — ${snap.error}` : ''),
          );
          // Row counts/logs are path-independent — always reported once,
          // here. The "grounded via X" headline note is path-specific and
          // gets pushed later, once low-code vs ADK is known — except a total
          // resolution failure, which is equally true on either path.
          if (!snap.resourcePath) {
            result.fidelity.push({
              component: `knowledge:${src.name}`,
              status: 'needs-review',
              detail:
                `Dataverse table snapshot could not run: ${snap.error}` +
                (snap.viaBigQuery
                  ? ' — this table is large enough to require the BigQuery path; ask the Google admin to enable the BigQuery API and grant the service account bigquery.dataEditor + bigquery.jobUser on this project, then re-run.'
                  : ''),
            });
          } else {
            for (const note of snap.schemaNotes ?? []) {
              result.fidelity.push({ component: `knowledge:${src.name}`, status: 'partial', detail: note });
            }
          }
        }
      }

      // BOTH paths run for every SharePoint source, not one-or-the-other:
      //   1. The real native connector setup is always genuinely attempted
      //      below (resolveSharePointConnectorSources) — so a real connector
      //      object exists and is visible in Console, honestly reported as
      //      whatever its actual state is (confirmed broken as of 2026-08-06,
      //      see knowledgeClassifier.ts — this does NOT fake success).
      //   2. Copy mode (below) is ALSO always attempted for any source that
      //      resolves to one specific file, and its result is what actually
      //      feeds the agent's answers — since the native connector doesn't
      //      return content today. If Google ever fixes the native connector,
      //      the honest "needs-review" note on the connector attempt is the
      //      trigger to revisit whether copy mode is still needed.
      let spCopyModeResolved: SharePointCopyModeResolution[] = [];
      if (spConnectorSources.length) {
        const copyMode = await resolveSharePointCopyModeSources(dest.project, saToken, await graphToken(), row.sourceId, spConnectorSources);
        spCopyModeResolved = copyMode.resolved;
        for (const l of copyMode.logs) emitLog(l.level, l.text);
      }
      // A source fully covered by copy mode doesn't need the native
      // connector's separate "still broken" caveat repeated — the real need
      // (this source's content) is already met. Only sources copy mode did
      // NOT cover (whole-site/multi-file references) still surface that
      // caveat, since for THOSE the connector's honest status is the only
      // signal there is — suppressing it there would be a real overclaim.
      const spCopyModeCoveredSrcs = new Set<KnowledgeSourceIR>(spCopyModeResolved.map((r) => r.src));

      const spResult = spConnectorSources.length
        ? await resolveSharePointConnectorSources(appUserId, dest, saToken, spConnectorSources)
        : { resolved: [] as SharePointConnectorResolution[], notes: [] as FidelityNote[], logs: [] as { level: 'info' | 'ok' | 'warn' | 'fail'; text: string }[] };
      for (const note of spResult.notes) result.fidelity.push(note);
      for (const l of spResult.logs) emitLog(l.level, l.text);
      const spResolved = spResult.resolved;

      // SharePoint federated connectors need ONE more Google-side, Console-only
      // step before they ever return real content: a manual "Authorize" click
      // on the data store — and that control only becomes reachable in Console
      // once the store is attached to an app's engine (Engine.dataStoreIds).
      // Discovery Engine has no REST endpoint for the Authorize handshake
      // itself (see geminiConnector.ts), so attach unconditionally, BEFORE the
      // low-code/ADK decision below, regardless of which path wins — ADK's own
      // VertexAiSearchTool queries the data store directly and doesn't need
      // the attach to function, but without it the store never surfaces in
      // any app's "Manage your data" page and Authorize can never be clicked.
      // (Confirmed empirically 2026-08-05: a SharePoint connector attached
      // only via the low-code fallback path — which never ran because ADK won
      // every time — sat outside every app's connected data, unreachable in
      // Console, and returned zero content even with correct Entra consent.)
      const spAttached: { src: KnowledgeSourceIR; siteUrl: string; dataStoreIds: string[]; attached: number; failedAttach: number }[] = [];
      for (const { src, siteUrl, dataStoreIds } of spResolved) {
        let attached = 0;
        let failedAttach = 0;
        for (const dsId of dataStoreIds) {
          const attach = await attachDataStoreToEngine(dest, saToken, dsId);
          if (attach.ok) attached++;
          else failedAttach++;
        }
        spAttached.push({ src, siteUrl, dataStoreIds, attached, failedAttach });
      }

      // Confluence pre-resolution: crawl BEFORE ADK deploy so the data store
      // path is baked into VertexAiSearchTool at deploy time. The same
      // dataStoreId is used in the post-create block for low-code attachment
      // (migrateConfluenceToDataStore is idempotent — returns the same store).
      let preCfResult: ConfluenceMigrationResult | null = null;
      let preCfCredsIncomplete = false;
      // Confluence data store paths, collected here and folded into
      // groundingDataStores at deploy time. Kept separate from dvResolved/spResolved
      // because the Confluence crawl is the only source those two do not cover —
      // dropping it silently un-grounds every Confluence agent.
      const connectorGroundingDataStores: string[] = [];
      // Paired with connectorGroundingDataStores by index — same reasoning as
      // groundedFileNames below: the model must cite the real space names, not
      // a generic tool index.
      const connectorGroundedNames: string[] = [];

      // SharePoint pre-resolution: crawl the folder the SOURCE agent named, via
      // Microsoft Graph, before the ADK deploy so the store path is baked into
      // VertexAiSearchTool.
      //
      // Graph, not Google's SharePoint connector: that connector talks to SharePoint's
      // own REST API, which only accepts app-only tokens minted with a CERTIFICATE
      // (appidacr=2). The client secret customers actually supply produces appidacr=1
      // and every call returns 401 "Unsupported app only token" — which is why the
      // pre-existing connectors in the test project sit at 0 documents. Graph accepts
      // the same secret, so this path works with credentials a customer can provide.
      //
      // spScopeUri is ALSO captured here and handed to the live SharePoint tools. Without
      // it those tools are unscoped: the app credential carries Sites.Read.All, which
      // reads EVERY site in the tenant (99 in the test tenant) while the source agent
      // named exactly one folder. Scope must come from the source, per agent.
      let preSpResult: SharePointMigrationResult | null = null;
      let spScopeUri = '';
      const spGraphSources = ks.filter(
        (s) => s.kind !== 'FileUpload' && /sharepoint\.com/i.test(s.reference ?? s.references?.[0] ?? ''),
      );
      // Microsoft app credentials come from the shared ms_graph group — the same set
      // every Microsoft connector uses, saved once by the customer.
      const msCreds = resolvedConnectors.find((c) =>
        c.connectorId === 'shared_sharepointonline' || c.connectorId === 'shared_onedrive',
      )?.fields;
      if (spGraphSources.length && dest.project && msCreds?.tenant_id && msCreds?.client_id && msCreds?.client_secret) {
        spScopeUri = spGraphSources[0].reference ?? spGraphSources[0].references?.[0] ?? '';
        emitLog('info', `    SharePoint: crawling ${spScopeUri} for grounding…`);
        preSpResult = await migrateSharePointToDataStore(
          dest.project, saToken, row.mapped.ir.sourceId,
          { tenantId: msCreds.tenant_id, clientId: msCreds.client_id, clientSecret: msCreds.client_secret, siteUrl: spScopeUri },
        ).catch((err): SharePointMigrationResult => {
          logger.warn({ err }, 'orchestrator: SharePoint pre-crawl threw; continuing');
          return { fileCount: 0, skipped: [], error: (err as Error).message };
        });
        if (preSpResult.resourcePath) {
          connectorGroundingDataStores.push(preSpResult.resourcePath);
          connectorGroundedNames.push(`SharePoint (${spScopeUri})`);
          emitLog('ok', `    SharePoint: ${preSpResult.fileCount} file(s) indexed.`);
        } else {
          emitLog('warn', `    SharePoint crawl failed: ${preSpResult.error ?? 'unknown'}.`);
        }
        for (const sk of preSpResult.skipped.slice(0, 5)) {
          result.fidelity.push({
            component: `knowledge:${sk.name}`,
            status: 'lost',
            detail: `SharePoint file not indexed — ${sk.reason}.`,
          });
        }
      }

      if (confluenceConnector && dest.project) {
        const confluenceKs = ks.filter(
          (s) => Array.isArray(s.confluenceSpaceNames) && s.confluenceSpaceNames.length > 0,
        );
        if (confluenceKs.length > 0) {
          const allCfSpaceNames: string[] = [
            ...new Set(confluenceKs.flatMap((s) => s.confluenceSpaceNames as string[])),
          ];
          const cfCreds: ConfluenceCreds = {
            base_url: confluenceConnector.fields['base_url'] ?? '',
            email: confluenceConnector.fields['email'] ?? '',
            api_token: confluenceConnector.fields['api_token'] ?? '',
            spaceNames: allCfSpaceNames,
          };
          if (cfCreds.base_url && cfCreds.email && cfCreds.api_token) {
            emitLog('info', `    Confluence: crawling ${allCfSpaceNames.length} space(s) for grounding…`);
            preCfResult = await migrateConfluenceToDataStore(
              dest.project, saToken, row.mapped.ir.sourceId, cfCreds,
            ).catch((err): ConfluenceMigrationResult => {
              logger.warn({ err }, 'orchestrator: Confluence pre-crawl threw; continuing');
              return { pageCount: 0, spaceCount: 0, error: (err as Error).message };
            });
            if (preCfResult.dataStoreId) {
              connectorGroundingDataStores.push(dataStoreResourcePath(dest.project, preCfResult.dataStoreId));
              connectorGroundedNames.push(`Confluence (${allCfSpaceNames.join(', ')})`);
              emitLog('ok', `    Confluence: ${preCfResult.pageCount} page(s) ready — data store queued for grounding.`);
            } else {
              emitLog('warn', `    Confluence crawl failed: ${preCfResult.error ?? 'unknown'}.`);
            }
          } else {
            preCfCredsIncomplete = true;
          }
        }
      }

      // ADK-first: try the ADK/Reasoning-Engine path BEFORE low-code, not
      // after it. Historically low-code was tried first and ADK only kicked
      // in once it came back stuck PRIVATE — but NO Gemini Enterprise edition
      // auto-lists an API-created low-code agent (see .claude/memory/
      // gemini-editions-agent-visibility.md — Business's "self-serve manual
      // publish button" is a human console click this automated pipeline
      // never performs). So the low-code attempt, tried first, NEVER reached
      // ENABLED and ADK fallback fired anyway, every single time — confirmed
      // empirically 2026-08-05 (every low-code-created agent in this
      // project's gallery shows Private, zero exceptions across many runs).
      // That means the low-code attempt was ALWAYS a wasted agent-creation
      // quota unit (this project's real quota is tiny and undocumented —
      // ~7/day empirically, see docs/SUPPORT-TICKET-AGENT-QUOTA.md) plus a
      // wasted follow-up cleanup-delete call once ADK replaced it. Low-code
      // is now attempted ONLY as a last resort if ADK itself fails, so a
      // customer still gets SOMETHING (a Private agent) rather than a hard
      // failure — same safety net as before, inverted order, and no orphaned
      // low-code agent to clean up in the (now-typical) case where ADK
      // succeeds outright, since nothing was created ahead of it.
      //
      // Tracks whether the FINAL create.agentId is actually the ADK/Reasoning-
      // Engine agent (vs. a last-resort low-code consolation) — downstream
      // publish/share/knowledge-file logic branches on this, so it must
      // reflect the real outcome, not just "did we attempt ADK".
      let usedAdk = false;
      // Captured when the ADK deploy succeeds, so verification can ask the deployed
      // agent a real question rather than only confirming the resource exists.
      let adkReasoningEngineId: string | undefined;
      /** How many data stores the ADK deploy was given — drives whether verification
       *  requires the agent to retrieve something. */
      let adkGroundedStoreCount = 0;
      // True when the agent was created via low-code + dataStoreSpecs (native
      // grounding), bypassing ADK/RE entirely for connector-grounded agents.
      let usedDataStoreSpecs = false;
      const create: CreateOutcome = await (async () => {
            // Idempotency: Reasoning Engine `create` has no name-based dedup of
            // its own (unlike low-code's agents.create) — check our own record
            // FIRST so a re-run reuses the existing deployment instead of
            // minting a second, billable Reasoning Engine.
            const existing = await getAdkDeployment(appUserId, row.envUrl, row.sourceId, dest);
            if (existing) {
              const priorSnapshot = await getMigratedSnapshot(appUserId, row.envUrl, row.sourceId, dest);
              // An explicit force wins over every skip below. Drift only knows about the
              // SOURCE agent, so without this there is no way to push a change that
              // originates on OUR side — a corrected tool name, a newly wired connector —
              // onto an agent that is already migrated.
              if (plan.forceRedeploy) {
                emitLog('warn', `  ${row.name}: forced redeploy — deploying again even though the source is unchanged.`);
              } else if (!priorSnapshot) {
                // Migrated before drift-tracking existed — record a baseline now
                // rather than guess whether it changed; drift detection starts
                // for real from the NEXT re-run.
                await saveMigratedSnapshot(appUserId, row.envUrl, row.sourceId, dest, snapshotFrom(row.mapped!.ir, savedConnectors));
                result.fidelity.push({
                  component: 'resync',
                  status: 'needs-review',
                  detail: 'No prior sync snapshot existed for this agent (migrated before drift-tracking was added) — baseline recorded now; drift will be detected starting next re-run.',
                });
                usedAdk = true;
                return { created: true, agentId: existing.agentId, alreadyExists: true };
              }
              // Drift covers the SOURCE agent AND the connectors configured on our side
              // (see driftDetector.ts) — configuring Jira and re-running otherwise skipped
              // the agent as "already exists" with no way to get the tool onto it.
              const drift = priorSnapshot
                ? detectDrift(priorSnapshot, row.mapped!.ir, savedConnectors)
                : { changed: true, reasons: ['no prior snapshot'] };

              // "No source drift" used to mean an unconditional skip — but
              // skipping never checked whether the DESTINATION side was still
              // healthy. Confirmed live 2026-08-06: a knowledge file's data
              // store deleted out-of-band (manual cleanup/console testing)
              // left the agent silently answering from nothing, forever,
              // since nothing on the source ever changes to trigger a
              // redeploy. Check destination health too, so "skip" only means
              // "genuinely nothing to do," not "nothing on the source changed."
              const fileSources = row.mapped!.ir.knowledgeSources.filter((k) => k.kind === 'FileUpload' && k.file?.name);
              const unhealthyFiles: string[] = [];
              for (const k of fileSources) {
                const cached = await getAdkKnowledgeStore(appUserId, row.sourceId, k.file!.name!, dest.project);
                const healthy = cached?.status === 'done' && (await dataStoreExists(dest.project, saToken, cached.dataStoreId));
                if (!healthy) unhealthyFiles.push(k.file!.name!);
              }
              // Same idea for native-SharePoint-connector-grounded sources:
              // resolveSharePointConnectorSources (above) already re-verifies
              // its cached dataStoreIds against Google every run and drops
              // dead ones — so a source that's connector-covered but didn't
              // make it into spResolved (and isn't covered by copy mode
              // either) means its data store was deleted out-of-band. Without
              // this check, "no source drift" would skip redeploying and the
              // agent would keep the stale reference forever, hard-crashing
              // with a 404 on every query instead of the graceful "lost"
              // this catches and repairs via the same redeploy path below.
              const spCoveredNames = new Set(spResolved.filter((r) => r.dataStoreIds.length).map((r) => r.src.name));
              const unhealthySharePoint = spConnectorSources
                .filter((src) => !spCopyModeCoveredSrcs.has(src) && !spCoveredNames.has(src.name))
                .map((src) => src.name);

              // Three independent reasons to redeploy: the source changed, the destination
              // broke, or a human asked for it. forceRedeploy is last because it is the
              // only one that is a decision rather than an observation.
              if (!drift.changed && !unhealthyFiles.length && !unhealthySharePoint.length && !plan.forceRedeploy) {
                usedAdk = true;
                return { created: true, agentId: existing.agentId, alreadyExists: true };
              }
              // Something needs fixing — either the SOURCE changed, the DESTINATION
              // knowledge broke, or a redeploy was requested. Either way, do NOT return
              // here: fall through to the same deploy flow a fresh agent uses, so the ADK
              // agent actually picks up the fix (redeploy is the only way; ADK create has
              // no in-place update — see adkDeployments.ts).
              // publishAgentToGallery is called below with existingAgentId set,
              // so this repoints the SAME agent at a fresh Reasoning Engine —
              // it does NOT register a second, duplicate gallery agent.
              //
              // Each branch says what actually happened. Claiming the source changed when
              // it did not sends someone hunting for an edit in Copilot Studio that never
              // happened.
              if (drift.changed) {
                emitLog('warn', `  ${row.name}: source changed since last migration (${drift.reasons.join(', ')}) — redeploying via ADK.`);
                result.fidelity.push({
                  component: 'resync',
                  status: 'mapped',
                  detail: `Source changed since last migration (${drift.reasons.join(', ')}) — redeployed via ADK to pick up the change (same agent, repointed — not a duplicate). The previous Reasoning Engine is NOT automatically deleted (no delete capability exists for it yet) — it may still exist and bill separately; delete manually if so.`,
                });
              } else if (unhealthyFiles.length || unhealthySharePoint.length) {
                const unhealthy = [...unhealthyFiles, ...unhealthySharePoint];
                emitLog('warn', `  ${row.name}: source unchanged, but knowledge source(s) [${unhealthy.join(', ')}] are missing/broken on the destination — repairing via redeploy.`);
                result.fidelity.push({
                  component: 'resync',
                  status: 'mapped',
                  detail: `Source unchanged, but knowledge source(s) [${unhealthy.join(', ')}] were missing/broken on the destination (e.g. deleted manually/console testing) — redeployed via ADK to repair (same agent, repointed — not a duplicate). The previous Reasoning Engine is NOT automatically deleted — it may still exist and bill separately.`,
                });
              } else {
                emitLog('warn', `  ${row.name}: source unchanged and destination healthy, but a redeploy was requested — redeploying via ADK.`);
                result.fidelity.push({
                  component: 'resync',
                  status: 'mapped',
                  detail: 'A redeploy was requested (forceRedeploy) even though nothing about the source agent or its destination knowledge had changed — redeployed via ADK so a fix made on our side reaches this agent (same agent, repointed — not a duplicate). The previous Reasoning Engine is NOT automatically deleted — it may still exist and bill separately.',
                });
              }
            }
            const websiteSource = firstWebsiteSource(row.mapped!.ir);

            // Connector-grounded agents (Confluence, SharePoint, Dataverse snapshots)
            // used to be diverted here to low-code + dataStoreSpecs, on the belief that
            // Reasoning Engines always fail at query time with "class_method='query' not
            // found". That was our bug, not Google's: ADK-framework engines simply do not
            // expose a `query` method (only create_session / stream_query /
            // async_stream_query / streaming_agent_run_with_events), and stream_query
            // requires `user_id`. Called correctly, a deployed RE answers fine — verified
            // live against a Confluence-grounded deployment (see
            // spikes/_probe_adk_agent_answers.ts and _diag_re_class_methods.ts).
            //
            // So connector stores now flow into the ADK deploy's groundingDataStores
            // (merged below with file-grounded stores), which is strictly better than the
            // low-code path: registerAdkAgent returns state=ENABLED — no admin Publish
            // click — and VertexAiSearchTool bakes the data store resource path into the
            // deployment, so it needs neither an engine.dataStoreIds attach nor the
            // several-minute serving propagation that attach requires. Low-code remains
            // the last-resort fallback further down if the deploy itself fails.

            // ADK agents have no agentFiles concept at all (unlike low-code —
            // see attachKnowledgeFiles below), so uploaded files must be
            // grounded via a Discovery Engine "document" data store +
            // VertexAiSearchTool INSTEAD, resolved before deploy since the
            // tool must be baked into the agent at create time, not patched
            // in afterward. Idempotent via adkKnowledgeStores: a re-run reuses
            // the same data store instead of re-uploading to GCS every time.
            const adkFileSources = row.mapped!.ir.knowledgeSources.filter((k) => k.kind === 'FileUpload' && k.file?.name);
            const fileGroundingDataStores: string[] = [];
            const groundedFileNames: string[] = [];
            if (adkFileSources.length) {
              const dvToken = await tokenFor(row.envUrl);
              for (const k of adkFileSources) {
                const name = k.file!.name!;
                const cached = await getAdkKnowledgeStore(appUserId, row.sourceId, name, dest.project);
                if (cached?.status === 'done') {
                  // Don't trust the cache blindly — the data store may have been
                  // deleted since (manual cleanup, console testing). A stale
                  // resourcePath baked into a new ADK deploy produces an agent
                  // that reports `mapped` here but can never retrieve anything.
                  if (await dataStoreExists(dest.project, saToken, cached.dataStoreId)) {
                    fileGroundingDataStores.push(cached.resourcePath);
                    groundedFileNames.push(name);
                    continue;
                  }
                  logger.warn(
                    `ADK knowledge store cache stale for "${name}" (dataStoreId=${cached.dataStoreId}) — ` +
                      'data store no longer exists in Discovery Engine; recreating.',
                  );
                }
                const got = await fetchFileAttachmentBytes(row.envUrl, dvToken, k.id);
                if (!got) {
                  result.fidelity.push({
                    component: `knowledge:${name}`,
                    status: 'lost',
                    detail: 'Could not download the file from Dataverse for ADK grounding (see server logs for the HTTP status).',
                  });
                  continue;
                }
                const ground = await migrateFileToDocumentStore(dest.project, saToken, row.sourceId, {
                  name,
                  bytes: got.bytes,
                  mimeType: mimeTypeForFile(name, got.contentType),
                });
                if (ground.resourcePath) {
                  fileGroundingDataStores.push(ground.resourcePath);
                  groundedFileNames.push(name);
                  await upsertAdkKnowledgeStore({
                    appUserId,
                    project: dest.project,
                    sourceId: row.sourceId,
                    fileName: name,
                    dataStoreId: ground.dataStoreId ?? '',
                    resourcePath: ground.resourcePath,
                    status: 'done',
                  });
                } else {
                  // Not necessarily a real failure — Discovery Engine's
                  // indexing has been observed to take 6-10+ minutes past
                  // import, longer than any poll budget this request can
                  // block on. Schedule a background recheck so this heals
                  // itself within ~30 min if it was just slow, instead of
                  // staying `lost` until someone manually re-runs the
                  // migration or a repair script (see groundingRecheck.ts).
                  if (ground.dataStoreId) {
                    await schedulePendingGroundingRecheck(
                      appUserId,
                      row.envUrl,
                      row.sourceId,
                      dest,
                      name,
                      ground.dataStoreId,
                      new Date(Date.now() + 5 * 60_000),
                    );
                  }
                  result.fidelity.push({
                    component: `knowledge:${name}`,
                    status: 'needs-review',
                    detail: `ADK file grounding did not confirm as indexed yet (${ground.error ?? 'unknown error'}) — a background check will retry for up to ~30 minutes and auto-repair this agent once indexing completes, no re-run needed.`,
                  });
                }
              }
            }

            // Combine every resolved grounding source — uploaded files, Dataverse
            // snapshots, SharePoint connectors, and the Confluence crawl. adk_deploy.py
            // (2026-08-05 fix, live-verified against 2 real combined stores) wires a
            // single store via the built-in VertexAiSearchTool, and 2+ stores via
            // hand-rolled, distinctly-named FunctionTools instead of combining
            // VertexAiSearchTool instances (which crashed every query — see
            // decisions.md: data_store_specs misuse -> missing runtime dependency ->
            // duplicate function name, each root-caused and fixed in turn).
            // Paired with the REAL source name (file name / site name), not a
            // generic index — adk_deploy.py names and documents each per-store
            // tool after this so the model cites something a customer actually
            // recognizes (confirmed live 2026-08-06: without this, the model
            // cited its own tool name, e.g. "search_knowledge_source_1", back
            // to the end user instead of the real file name).
            //
            // connectorGroundingDataStores stays in this list: it carries the
            // pre-resolved Confluence store (see preCfResult above), which is NOT
            // covered by dvResolved/spResolved. Dropping it silently un-grounds every
            // Confluence agent.
            const groundingDataStores = [
              ...fileGroundingDataStores.map((resourcePath, i) => ({ resourcePath, sourceName: groundedFileNames[i] })),
              ...connectorGroundingDataStores.map((resourcePath, i) => ({ resourcePath, sourceName: connectorGroundedNames[i] })),
              ...dvResolved.filter((r) => r.snap.resourcePath).map((r) => ({ resourcePath: r.snap.resourcePath!, sourceName: r.src.name })),
              ...spCopyModeResolved.map((r) => ({ resourcePath: r.resourcePath, sourceName: r.src.name })),
              ...spResolved.flatMap((r) =>
                r.dataStoreIds.map((id, i) => ({
                  resourcePath: dataStoreResourcePath(dest.project, id),
                  sourceName: r.dataStoreIds.length > 1 ? `${r.src.name} (${i + 1})` : r.src.name,
                })),
              ),
            ];
            // Configured third-party connectors become REAL callable tools on the
            // deployment (secret ids only — resolved in-container per call). This is
            // what lets a migrated connector actually hit Jira/Slack/Graph, as opposed
            // to the old instruction block that merely described the API to a model
            // with no way to call it.
            // Scope the SharePoint/OneDrive tools to THIS agent's own folder. The
            // specs are shared across agents, so the scope has to be applied per agent
            // rather than baked in when they were built.
            // Which operations did THIS agent invoke on each connector? The specs are
            // built once per run from the saved credentials, but the operations are a
            // property of the individual agent, so they are attached here rather than
            // there. They shape the tool's description only — the tool can still call
            // anything the credentials permit.
            // Carry the operation DESCRIPTIONS too, not just the ids. Copilot Studio shows
            // the author a description per operation ("This operation returns a list of
            // issues using JQL"); that is the clearest statement of what the agent was
            // built to do, and dropping it left the migrated tool describing itself in
            // our words instead of the source's.
            const opsByConnector = new Map<string, Array<{ id: string; description?: string }>>();
            for (const tool of row.mapped!.ir.agentTools ?? []) {
              if (!tool.connectorId || !tool.operationId) continue;
              const list = opsByConnector.get(tool.connectorId) ?? [];
              if (!list.some((o) => o.id === tool.operationId)) {
                list.push({ id: tool.operationId, description: tool.description });
              }
              opsByConnector.set(tool.connectorId, list);
            }
            // Wire ONLY the connectors THIS agent uses.
            //
            // Every saved credential used to be wired onto every agent: an agent using
            // three connectors received nine, including live API access to systems its
            // Copilot original never touched. That is a security problem before it is a
            // quality one, and it also caused a real outage — two of the unused
            // connectors (SharePoint + OneDrive) collided on tool names and 400'd every
            // message (live 2026-08-07).
            //
            // The agent's own tools name their connectors, and a knowledge source that
            // needs a crawler names one implicitly. Anything else is dropped and
            // reported, never silently.
            const usedConnectorIds = agentConnectorIds(row.mapped!.ir);

            // Connectors this agent genuinely uses that we have no registry entry for.
            // These cannot become tools, and used to vanish with only a server-log
            // warning — the agent deployed green while missing a capability its Copilot
            // original had. Report it as lost, per agent, with the operations it wanted.
            //
            // Derived from what THIS AGENT uses, not from what the customer configured.
            // `unsupportedConnectorIds` comes from `savedConnectors` — the connectors
            // credentials were saved for — so a connector the agent calls that we have
            // never heard of (every CUSTOM connector, and any first-party one the customer
            // did not configure) was absent from that list and reported nowhere. The
            // registry is the authority on what we can build a tool for; ask it directly.
            const unsupportedForThisAgent = [...usedConnectorIds].filter(
              (id) => !REGISTRY_BY_ID.has(id),
            );
            for (const missingId of unsupportedForThisAgent) {
              const wanted = (opsByConnector.get(missingId) ?? []).map((o) => o.id);
              result.fidelity.push({
                component: `connector:${missingId}`,
                status: 'lost',
                detail:
                  `This agent calls "${missingId}", which CloudFuze Studio Migrate has no connector support for, ` +
                  `so no tool was created for it and the migrated agent cannot perform those actions.` +
                  (wanted.length ? ` Operations the source agent used: ${wanted.join(', ')}.` : ''),
              });
              emitLog('warn', `  ${row.name}: "${missingId}" is not a supported connector — its tools were NOT migrated.`);
            }

            // Beyond "is there a registry entry", report per OPERATION whether we can
            // actually reproduce the call the source agent made. A connector can be
            // registered and still have operations we cannot rebuild (SharePoint's
            // HttpRequest tunnel, Google Drive's dataset abstraction), and an
            // unregistered one can be fully reproducible (Dataverse). Reporting only at
            // connector granularity gets both cases wrong.
            for (const [connectorId, ops] of opsByConnector) {
              if (!usedConnectorIds.has(connectorId)) continue;
              const readiness = readinessFor(connectorId, ops.map((o) => o.id));
              if (!readiness) continue; // no captured API for this connector — already covered above
              for (const blockedOp of readiness.blocked) {
                result.fidelity.push({
                  component: `connector:${connectorId}:${blockedOp.operationId}`,
                  status: 'lost',
                  detail:
                    `This agent calls "${blockedOp.operationId}" on ${readiness.displayName}, which the ` +
                    `migrated agent cannot reproduce. ${blockedOp.reason}`,
                });
                emitLog(
                  'warn',
                  `  ${row.name}: ${connectorId}.${blockedOp.operationId} cannot be reproduced — reported as lost.`,
                );
              }
            }

            const applicable = liveConnectorSpecs.filter((c) => usedConnectorIds.has(c.id));
            const droppedConnectors = liveConnectorSpecs
              .filter((c) => !usedConnectorIds.has(c.id))
              .map((c) => c.name);
            if (droppedConnectors.length) {
              emitLog(
                'info',
                `    ${row.name}: ${applicable.length} connector(s) apply to this agent; not wiring ${droppedConnectors.join(', ')} (configured, but this agent does not reference them).`,
              );
            }

            // Reproduce the CALL, not just the capability: one typed tool per operation the
            // source agent invoked, with the arguments its author pinned. Falls back to the
            // generic REST tool for any connector this produces nothing for, so a connector
            // we cannot bind still deploys with the behaviour it had yesterday.
            const boundBuild = await buildBoundToolSpecs(row.mapped!.ir, captureCtxFor(row.envUrl), {
              dataverseOrgUrl: row.envUrl ?? '',
            });
            result.fidelity.push(...boundBuild.notes);
            for (const note of boundBuild.notes) {
              if (note.status === 'lost') emitLog('warn', `  ${row.name}: ${note.detail}`);
            }

            const scopedConnectors = applicable.map((c) => {
              const withOps = opsByConnector.has(c.id) ? { ...c, operations: opsByConnector.get(c.id) } : c;
              const bound = boundBuild.byConnector.get(c.id);
              const withBound = bound?.length ? { ...withOps, boundOperations: bound } : withOps;
              return /sharepoint|onedrive/i.test(withBound.kind) && spScopeUri
                ? { ...withBound, scopeUri: spScopeUri }
                : withBound;
            });
            const boundCount = [...boundBuild.byConnector.values()].reduce((n, l) => n + l.length, 0);
            if (boundCount) {
              emitLog(
                'info',
                `    ${row.name}: ${boundCount} connector operation(s) rebuilt as exact API calls with the source agent's own arguments.`,
              );
            }

            // Copilot topics become ADK sub-agents INSIDE this deployment. Not one
            // Reasoning Engine per topic: that would multiply cost and burn the ~7/day
            // agent-creation quota on a single migrated agent.
            const topicSubAgents = row.mapped!.ir.topics
              .filter((t) => !t.isSystem && t.name?.trim())
              .map((t) => {
                const name = t.name.trim();
                return {
                  id: name,
                  displayName: name,
                  // The root agent routes on this text, so it must say WHEN to hand
                  // over — a description that only restates the name routes nothing.
                  description: `Handles "${name}" requests — the migrated Copilot topic of the same name.`,
                  instruction:
                    `You handle the "${name}" topic, migrated from Microsoft Copilot Studio.
` +
                    (t.aiPrompt ? `
Original AI Builder prompt:
${t.aiPrompt}
` : '') +
                    `
If the request is outside "${name}", say so briefly so the main assistant takes over.`,
                };
              });
            if (topicSubAgents.length) {
              emitLog('info', `    ${row.name}: ${topicSubAgents.length} topic(s) → sub-agents in one engine.`);
            }

            const adk = await publishAgentToGallery(dest, saToken, row.mapped!.ir, {
              websiteSource,
              groundingDataStores,
              liveConnectors: scopedConnectors,
              subAgents: topicSubAgents,
              // Redeploying an agent we already migrated: repoint the EXISTING agent at
              // the new Reasoning Engine rather than creating a second one. Creation is
              // capped by an undocumented daily quota and re-runs used to burn one every
              // time, while also accumulating same-named duplicates.
              existingAgentId: existing?.agentId,
            });

            // Everything below claims specific knowledge sources are grounded
            // on "the ADK agent" — that's only true if ADK is actually the
            // FINAL agent. Gate ALL of these notes on adk.ok, not just the
            // usedAdk/deployment bookkeeping — otherwise, when ADK ultimately
            // fails and the code falls back to the stuck-PRIVATE low-code
            // agent below, the report keeps claiming ADK grounding that
            // never actually reached the agent the customer is looking at
            // (live-confirmed 2026-08-05: exactly this happened — both an
            // ADK "mapped" note and a low-code "engine-wide" note showed up
            // for the same source, because the ADK notes were pushed before
            // this check existed).
            if (adk.ok && adk.agentId && adk.reasoningEngine) {
              adkReasoningEngineId = adk.reasoningEngine.split('/').pop();
              adkGroundedStoreCount = groundingDataStores.length;
              for (const name of groundedFileNames) {
                result.fidelity.push({
                  component: `knowledge:${name}`,
                  status: adk.groundingIamGranted === false ? 'partial' : 'mapped',
                  detail:
                    adk.groundingIamGranted === false
                      ? 'Uploaded to a Discovery Engine document data store and wired as a VertexAiSearchTool, but Discovery Engine access for the Reasoning Engine service agent could not be confirmed/granted — grounding may 403 until an admin grants it manually (see docs/ADK-FILE-GROUNDING-PERMISSIONS.md).'
                      : 'Uploaded file grounded on the ADK agent via a Discovery Engine document data store + VertexAiSearchTool.',
                });
              }
              // Agent TOOLS (Copilot connector actions, MCP servers, connected agents,
              // AI Builder models). Every one is a capability the source agent had, so
              // every one must appear in the report — mapped when we wired a live tool
              // for its connector, lost when we did not. Without this a customer got a
              // clean report from an agent that used Jira, HubSpot and CData, none of
              // which were mentioned anywhere (live 2026-08-07). The UI already told
              // them unsupported connectors were "recorded in the migration report as a
              // gap" — until now that claim was simply untrue.
              const wiredConnectorIds = new Set(scopedConnectors.map((c) => c.id));
              for (const tool of row.mapped!.ir.agentTools ?? []) {
                const wired = !!tool.connectorId && wiredConnectorIds.has(tool.connectorId);
                const opText = tool.operationId ? ` (${tool.operationId})` : '';
                result.fidelity.push({
                  component: `tool:${tool.name}`,
                  status: wired ? 'mapped' : 'lost',
                  detail: wired
                    ? `Connector action${opText} — a live ${tool.connectorId} tool is wired on the migrated agent.`
                    : tool.kind === 'connector'
                      ? `Connector action${opText} on ${tool.connectorId ?? 'an unknown connector'} was NOT migrated — no credentials were configured for it, or the connector has no entry in our registry. The migrated agent cannot perform this action.`
                      : tool.kind === 'mcp-server'
                        ? `MCP server tool${opText} (${tool.connectorId ?? 'unknown'}) was NOT migrated — remote MCP servers attached in Copilot Studio have no equivalent in the migrated agent yet.`
                        : tool.kind === 'connected-agent'
                          ? 'This agent invoked ANOTHER Copilot agent as a tool. That relationship is not recreated — migrate the other agent and reconnect them manually.'
                          : tool.kind === 'ai-builder'
                            ? 'AI Builder model/prompt used as a tool — the prompt text is folded into the instruction where available, but the model itself is not migrated.'
                            : `Tool of an unrecognised kind was found and preserved in the IR but not migrated${opText}.`,
                });
              }

              for (const { src, snap } of dvResolved) {
                if (!snap.resourcePath) continue; // resolution failure already reported above
                result.fidelity.push({
                  component: `knowledge:${src.name}`,
                  status: adk.groundingIamGranted === false ? 'partial' : snap.failed ? 'needs-review' : 'mapped',
                  detail:
                    `Dataverse table "${src.name}" snapshotted into a per-agent Discovery Engine data store` +
                    (snap.viaBigQuery ? ` via BigQuery (${snap.attempted} row(s), large-table path)` : ` inline (${snap.attempted} row(s))`) +
                    ` and grounded via ADK's VertexAiSearchTool — per-agent, not engine-wide (unlike the low-code path, other agents sharing this engine do NOT get access). Point-in-time snapshot, not a live connection — refresh by re-running the migration.` +
                    (adk.groundingIamGranted === false
                      ? ' Discovery Engine access for the Reasoning Engine service agent could not be confirmed/granted — grounding may 403 until an admin grants it manually (see docs/ADK-FILE-GROUNDING-PERMISSIONS.md).'
                      : ''),
                });
              }
              for (const { src, fileName } of spCopyModeResolved) {
                // 'mapped', not 'needs-review': unlike the native connector
                // (see the spAttached note below), copy mode has no unverifiable
                // Console-only step — it's a plain Graph download + document
                // import, the same proven mechanism as an uploaded file, so a
                // successful result here really is grounded, not just wired.
                result.fidelity.push({
                  component: `knowledge:${src.name}`,
                  status: adk.groundingIamGranted === false ? 'partial' : 'mapped',
                  detail:
                    `SharePoint file "${fileName}" downloaded directly via Microsoft Graph and grounded via ADK's VertexAiSearchTool — Gemini's native SharePoint connector is confirmed broken as of 2026-08-06 (returns zero content even fully authenticated; see knowledgeClassifier.ts), so this source used the copy-mode workaround instead. Point-in-time copy, not a live connection — refresh by re-running the migration.` +
                    (adk.groundingIamGranted === false
                      ? ' Discovery Engine access for the Reasoning Engine service agent could not be confirmed/granted — grounding may 403 until an admin grants it manually (see docs/ADK-FILE-GROUNDING-PERMISSIONS.md).'
                      : ''),
                });
                emitLog('ok', `    "${src.name}": SharePoint connector confirmed broken — grounded "${fileName}" via copy mode instead.`);
              }
              for (const { src, siteUrl, attached, failedAttach } of spAttached) {
                if (spCopyModeCoveredSrcs.has(src)) continue; // already fully grounded via copy mode — redundant caveat, not a hidden problem
                // 'needs-review', not 'mapped': the ADK tool is correctly wired
                // to this data store, but SharePoint federated connectors need
                // a one-time, Console-only "Authorize" click before they ever
                // return real content, and Discovery Engine exposes no REST
                // endpoint to check or perform it — so wiring success here is
                // NOT proof the source actually returns content. Overclaiming
                // "mapped" for a connector we can't verify is a fidelity-
                // honesty violation (confirmed empirically 2026-08-05: a
                // "grounded" SharePoint source returned zero results because
                // Authorize had never been done, despite correct Entra consent).
                result.fidelity.push({
                  component: `knowledge:${src.name}`,
                  status: adk.groundingIamGranted === false || failedAttach ? 'partial' : 'needs-review',
                  detail:
                    `SharePoint site ${siteUrl}: wired via ADK's VertexAiSearchTool (per-agent, not engine-wide) and the data store attached to the app's engine (${attached}/${attached + failedAttach} succeeded) so it's reachable in Console. ` +
                    'This pipeline cannot confirm or perform the required one-time "Authorize" step on the data store — Discovery Engine has no REST endpoint for it. Verify in Cloud Console (app → Manage your data → this data store → Authorize) and confirm the agent actually returns SharePoint content before trusting this source.' +
                    (adk.groundingIamGranted === false
                      ? ' Discovery Engine access for the Reasoning Engine service agent could not be confirmed/granted — grounding may 403 until an admin grants it manually (see docs/ADK-FILE-GROUNDING-PERMISSIONS.md).'
                      : ''),
                });
                emitLog(
                  failedAttach ? 'warn' : 'ok',
                  `    "${src.name}": SharePoint connector for ${siteUrl} wired via ADK VertexAiSearchTool — confirm Console "Authorize" is done before trusting this source.`,
                );
              }
              if (adk.secretIamGranted === false) {
                // Deployment succeeded; the credentials it needs may not be readable.
                // This is exactly the shape that must never stay silent — the agent
                // looks migrated and then 403s on its first real question.
                result.fidelity.push({
                  component: 'connector:credentials-access',
                  status: 'needs-review',
                  detail:
                    'Per-secret access could not be granted to the Reasoning Engine service agent, so the connector tools ' +
                    'will fail at query time unless a project-wide roles/secretmanager.secretAccessor grant already exists. ' +
                    `Cause: ${adk.secretIamError ?? 'unknown'}.`,
                });
                emitLog('warn', `  ${row.name}: could not grant per-secret access — connector tools may 403 until an admin grants Secret Manager access.`);
              }
              if (adk.googleSearchDropped) {
                result.fidelity.push({
                  component: 'capability:web-browsing',
                  status: 'lost',
                  detail:
                    "Source agent had web browsing enabled, but this agent also has knowledge sources configured — ADK (pre-1.16) only allows VertexAiSearchTool alone once any knowledge source exists, so googleSearch was dropped rather than silently answering from the open web whenever that knowledge fails to ground. If both web browsing and this knowledge are required together, this agent needs to stay on the low-code path instead.",
                });
                emitLog('warn', `  ${row.name}: web browsing dropped — ADK can't combine VertexAiSearchTool grounding with googleSearch on the same agent.`);
              }
              await recordAdkDeployment(appUserId, row.envUrl, row.sourceId, dest, {
                reasoningEngine: adk.reasoningEngine,
                agentId: adk.agentId,
              });
              await saveMigratedSnapshot(appUserId, row.envUrl, row.sourceId, dest, snapshotFrom(row.mapped!.ir, savedConnectors));
              emitLog('ok', `  ${row.name}: deployed via ADK (${adk.state}).`);
              usedAdk = true;
              return { created: true, agentId: adk.agentId };
            }
            // ADK failed — fall back to a low-code create so the customer gets
            // SOMETHING rather than a hard failure, but report the ADK error
            // honestly rather than let a "migrated" agent hide it (the exact
            // failure mode docs/connector-architecture-decisions.md §9 warns
            // about: an unset ADK_STAGING_BUCKET or wrong engine choice used
            // to produce a silently-degraded PRIVATE agent with no error
            // naming the cause).
            //
            // The low-code fallback still has real, permanent limitations
            // vs. ADK: it stays `state: PRIVATE` (Agent.state is readOnly,
            // there is no :publish method), and it carries no live connector
            // tools or topic sub-agents. What it does NOT lack anymore is
            // grounding — confirmed live 2026-08-07 that an engine-wide
            // attachDataStoreToEngine() call alone does not make a low-code
            // agent actually query a structured/connector data store; fixed
            // below by wiring the SAME resolved Dataverse/SharePoint stores
            // into the agent's own dataStoreSpecs (buildCreateBody()'s native
            // grounding mechanism) before creating it, same as a real
            // console-created agent.
            result.fidelity.push({
              component: 'adk-fallback',
              status: 'needs-review',
              detail:
                `ADK deployment failed (${adk.error ?? 'unknown error'}) — falling back to a low-code agent, which will stay PRIVATE (not gallery-visible, no API way to change that) and carries no live connector tools or topic sub-agents. It IS properly grounded on the same knowledge sources though. Fix the reported ADK error and re-run to get the full ADK feature set instead.`,
            });
            emitLog('warn', `  ${row.name}: ADK failed (${adk.error ?? 'unknown error'}) — falling back to low-code create.`);
            // Wire resolved Dataverse-snapshot / SharePoint sources into the
            // agent's OWN groundingDataStores before creating it — see the
            // comment above for why this is required, not optional.
            row.mapped!.groundingDataStores = [
              ...(row.mapped!.groundingDataStores ?? []),
              ...dvResolved.filter((r) => r.snap.resourcePath).map((r) => r.snap.resourcePath!),
              ...spCopyModeResolved.map((r) => r.resourcePath),
              ...spResolved.flatMap((r) => r.dataStoreIds.map((id) => dataStoreResourcePath(dest.project, id))),
            ];
            const lowCode = await createAgent(dest, saToken, row.mapped!);
            if (lowCode.alreadyExists) {
              return { created: false, alreadyExists: true, error: 'already exists' };
            }
            return lowCode.created && lowCode.agentId
              ? {
                  created: true,
                  agentId: lowCode.agentId,
                  state: lowCode.state,
                  error: `ADK failed (${adk.error}); created via low-code instead (state: ${lowCode.state ?? 'PRIVATE'}).`,
                }
              : { created: false, error: `ADK failed (${adk.error}); low-code fallback also failed: ${lowCode.error}` };
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
        // so the published revision includes them). Dataverse-snapshot and
        // SharePoint-connector sources were already RESOLVED earlier (before
        // the low-code/ADK decision, see dvResolved/spResolved above) —
        // only the ADK path's grounding notes were pushed already (inside
        // the ADK closure); the low-code attach step below still needs to run.
        const fileSources = ks.filter((k) => k.kind === 'FileUpload');
        if (usedAdk) {
          // Already handled BEFORE deploy, inside the ADK-fallback closure
          // above — ADK agents have no agentFiles concept, so uploaded files
          // are grounded via migrateFileToDocumentStore + VertexAiSearchTool
          // instead, and their fidelity notes were already pushed there.
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
        // Dataverse-snapshot / SharePoint-connector: resolved earlier (see
        // dvResolved/spResolved above), so this is attach-only here — the
        // low-code counterpart to the ADK grounding notes already pushed
        // inside the ADK closure when usedAdk is true.
        if (!usedAdk) {
          for (const { src, dataStoreId, fileName } of spCopyModeResolved) {
            await attachDataStoreToEngine(dest, saToken, dataStoreId);
            result.fidelity.push({
              component: `knowledge:${src.name}`,
              status: 'mapped',
              detail: `SharePoint file "${fileName}" downloaded directly via Microsoft Graph and attached to the agent's engine — Gemini's native SharePoint connector is confirmed broken as of 2026-08-06 (see knowledgeClassifier.ts), so this source used the copy-mode workaround instead. Engine-wide visibility like every other low-code attach. Point-in-time copy — refresh by re-running the migration.`,
            });
            emitLog('ok', `    "${src.name}": SharePoint connector confirmed broken — attached "${fileName}" via copy mode instead.`);
          }
          for (const { src, snap } of dvResolved) {
            if (!snap.resourcePath) continue; // resolution failure already reported earlier
            // Always attach, even on the dataStoreSpecs path. dataStoreSpecs does NOT
            // make a store reachable on its own: the engine rejects any store missing
            // from engine.dataStoreIds with 400 "Data stores ... are not found in the
            // engine", so an agent wired only via dataStoreSpecs can never retrieve
            // anything. Skipping the attach here is what left previously-migrated
            // agents silently ungrounded. Attach is idempotent (see geminiDataStore).
            await attachDataStoreToEngine(dest, saToken, snap.dataStoreId!);
            result.fidelity.push({
              component: `knowledge:${src.name}`,
              status: snap.failed ? 'needs-review' : 'mapped',
              detail:
                `Dataverse table "${src.name}" snapshotted into a Gemini structured data store` +
                (snap.viaBigQuery ? ` via BigQuery (${snap.attempted} row(s), large-table path)` : ` inline (${snap.attempted} row(s))`) +
                ` — ${snap.succeeded}/${snap.attempted} row(s) indexed` +
                (snap.failed ? `, ${snap.failed} failed` : '') +
                (usedDataStoreSpecs
                  ? '. Grounded per-agent via dataStoreSpecs — not engine-wide. Point-in-time snapshot, refresh by re-running the migration.'
                  : '. Point-in-time snapshot, not a live connection — refresh by re-running the migration.'),
            });
          }

          // SharePoint native-connector reconnect: already attached to the
          // engine unconditionally, above (spAttached) — this is note-only.
          for (const { src, siteUrl, dataStoreIds, attached, failedAttach } of spAttached) {
            if (spCopyModeCoveredSrcs.has(src)) continue; // already fully grounded via copy mode — redundant caveat, not a hidden problem
            if (attached && !failedAttach) {
              // 'needs-review', not 'mapped' or 'partial': attach succeeded
              // (engine-wide, per the caveat below) but that only makes the
              // Console "Authorize" control reachable — it doesn't confirm
              // the customer has clicked it. Discovery Engine has no REST way
              // to check, so we cannot claim this source actually returns
              // content (confirmed empirically 2026-08-05: an attached,
              // "reconnected" SharePoint source returned zero results with
              // correct Entra consent, purely because Authorize was never done).
              result.fidelity.push({
                component: `knowledge:${src.name}`,
                status: 'needs-review',
                detail: `SharePoint site ${siteUrl} reconnected via Gemini's native connector and attached to the agent's engine (engine-wide — every other agent sharing this engine can also search this site, even if it never referenced it in Copilot Studio). This pipeline cannot confirm or perform the required one-time "Authorize" step on the data store — verify in Cloud Console (app → Manage your data → this data store → Authorize) and confirm real content is returned before trusting this source.`,
              });
              emitLog('ok', `    "${src.name}": SharePoint connector for ${siteUrl} attached (${attached} data store(s)) — confirm Console "Authorize" is done before trusting this source.`);
            } else if (attached) {
              result.fidelity.push({
                component: `knowledge:${src.name}`,
                status: 'partial',
                detail: `SharePoint site ${siteUrl}: ${attached}/${dataStoreIds.length} data store(s) attached, ${failedAttach} failed. Even for the attached ones, Cloud Console's one-time "Authorize" step still needs manual confirmation.`,
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
          }
        }

        // Confluence knowledge: fidelity notes + low-code engine attachment.
        // Crawl already ran above (preCfResult) — here we only attach the
        // data store for the low-code fallback path (ADK already baked it in
        // via groundingDataStores / VertexAiSearchTool at deploy time).
        if (preCfResult !== null) {
          if (preCfResult.dataStoreId) {
            if (usedDataStoreSpecs) {
              // Data store already wired per-agent via dataStoreSpecs — no engine attach needed.
              result.fidelity.push({
                component: 'knowledge:Confluence',
                status: 'mapped',
                detail: `${preCfResult.pageCount} Confluence page(s) from ${preCfResult.spaceCount} space(s) indexed and grounded per-agent via dataStoreSpecs — not engine-wide.`,
              });
              emitLog('ok', `    Confluence: ${preCfResult.pageCount} page(s) indexed, grounded via dataStoreSpecs (per-agent).`);
            } else if (!usedAdk) {
              const cfAttach = await attachDataStoreToEngine(dest, saToken, preCfResult.dataStoreId);
              result.fidelity.push({
                component: 'knowledge:Confluence',
                status: cfAttach.ok ? 'partial' : 'needs-review',
                detail: cfAttach.ok
                  ? `${preCfResult.pageCount} Confluence page(s) from ${preCfResult.spaceCount} space(s) indexed and attached to this agent's engine.`
                  : `Confluence pages indexed but attaching data store to engine failed: ${cfAttach.error ?? 'unknown'}.`,
              });
              if (cfAttach.ok) {
                emitLog('ok', `    Confluence: ${preCfResult.pageCount} page(s) indexed and attached.`);
              } else {
                emitLog('warn', `    Confluence data store attach failed: ${cfAttach.error ?? 'unknown'}.`);
              }
            } else {
              result.fidelity.push({
                component: 'knowledge:Confluence',
                status: 'mapped',
                detail: `${preCfResult.pageCount} Confluence page(s) from ${preCfResult.spaceCount} space(s) grounded via ADK VertexAiSearchTool — per-agent, not engine-wide.`,
              });
            }
          } else {
            result.fidelity.push({
              component: 'knowledge:Confluence',
              status: 'needs-review',
              detail: `Confluence knowledge migration failed: ${preCfResult.error ?? 'unknown'}.`,
            });
            emitLog('warn', `    Confluence migration failed: ${preCfResult.error ?? 'unknown'}.`);
          }
        } else if (preCfCredsIncomplete) {
          result.fidelity.push({
            component: 'knowledge:Confluence',
            status: 'needs-review',
            detail: 'Confluence credentials incomplete (base_url / email / api_token required) — enter them in the Connectors step.',
          });
        }

        // Everything else non-file (websites already handled, connectors
        // already handled, sensitive tables, manual-review) has no automatic
        // path yet — reported honestly.
        const nonFile = ks.filter((k) => k.kind !== 'FileUpload' && k !== adkWebsiteSource);
        {
          const other = nonFile.filter((k) => !dvSnapshotSources.includes(k) && !spConnectorSources.includes(k));

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
          // Confluence sources are NOT searchable this way. Their `name` is a list of
          // space names ("Engineering, Chaitanya Malle, Demo Company Wiki"), not a
          // filename, so a Graph search can only ever return nothing — it spent a
          // Dataverse lookup plus a Graph round trip per source to log "no candidates"
          // (live 2026-08-07). They are handled by the Confluence crawler, and when
          // that cannot run the reason is already reported against the crawler.
          const searchable = other.filter(
            (k) =>
              k.kind === 'FederatedStructuredSearchSource' &&
              k.classification?.strategy !== 'confluence-crawler',
          );
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
          // 2026-07-31. When source chat access was narrower than org-wide,
          // record an honest over-share handoff (Gemini has no API to restrict
          // after the fact on this path).
          result.deployed = true;
          const perms = row.mapped.ir.permissions;
          const hasPerms = !!perms;
          const orgWide = !hasPerms || isOrgWideChat(perms);
          if (orgWide || allowOvershare) {
            result.shared = true;
            if (hasPerms && orgWide) {
              result.fidelity.push(...permissionFidelityNotes(perms, true, undefined));
            } else if (hasPerms && allowOvershare) {
              result.fidelity.push({
                component: 'sharing',
                status: 'needs-review',
                detail:
                  'Source chat access was narrower than org-wide, but allowOvershare was set — ADK registration left ALL_USERS.',
              });
            }
          } else {
            result.shared = true; // registration already shared; cannot undo via API
            const resolution = resolvePermissions(perms, {
              ownedDomains: orgProfile.ownedDomains,
              overrides: identityOverrides,
              knownGoogleUsers: orgProfile.google.verifiedUserEmails,
            });
            const handoff = buildPermissionHandoff(
              row.name,
              create.agentId,
              resolution,
              perms,
              'ADK registration shares ALL_USERS automatically; source was narrower — restrict via console Share / User permissions. Gemini API cannot apply per-user/group sharing.',
            );
            result.permissionHandoff = handoff;
            const grant = await grantAgentAccess(dest, saToken, create.agentId!, { users: handoff.grantUsers, groups: handoff.grantGroups });
            result.fidelity.push(...permissionFidelityNotes(perms, false, handoff));
            if (grant.granted.length) {
              result.fidelity.push({
                component: 'sharing',
                status: 'mapped',
                detail: `Auto-granted chat/use access (roles/discoveryengine.agentUser) to: ${grant.granted.join(', ')}.`,
              });
            }
            if (grant.failed.length) {
              result.fidelity.push({
                component: 'sharing',
                status: 'needs-review',
                detail: `Could not auto-grant access to ${grant.failed.map((f) => f.principal).join(', ')} — grant manually via console User permissions. (${grant.failed[0]?.error})`,
              });
            }
            emitLog(
              'warn',
              `  ${row.name}: ADK agent is ALL_USERS (platform default) but source was not org-wide — auto-granted ${grant.granted.length} principal(s), see report for any that failed.`,
            );
          }
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

          const perms = row.mapped.ir.permissions;
          const hasPerms = !!perms;
          // Backward compatible: if permissions were never extracted, keep
          // today's shareAgent(ALL_USERS) behavior.
          const orgWide = !hasPerms || isOrgWideChat(perms);
          if (orgWide || allowOvershare) {
            result.shared = await shareAgent(dest, saToken, create.agentId);
            if (hasPerms && orgWide) {
              result.fidelity.push(...permissionFidelityNotes(perms, true, undefined));
            } else if (hasPerms && allowOvershare && !orgWide) {
              result.fidelity.push({
                component: 'sharing',
                status: 'needs-review',
                detail:
                  'Source chat access was narrower than org-wide, but allowOvershare was set — shared ALL_USERS intentionally.',
              });
            }
          } else {
            result.shared = false;
            const resolution = resolvePermissions(perms, {
              ownedDomains: orgProfile.ownedDomains,
              overrides: identityOverrides,
              knownGoogleUsers: orgProfile.google.verifiedUserEmails,
            });
            const handoff = buildPermissionHandoff(
              row.name,
              create.agentId,
              resolution,
              perms,
              'Gemini API has no per-user/group agent sharing (only ALL_USERS). Manual console steps required.',
            );
            result.permissionHandoff = handoff;
            const grant = await grantAgentAccess(dest, saToken, create.agentId!, { users: handoff.grantUsers, groups: handoff.grantGroups });
            result.fidelity.push(...permissionFidelityNotes(perms, false, handoff));
            if (grant.granted.length) {
              result.fidelity.push({
                component: 'sharing',
                status: 'mapped',
                detail: `Auto-granted chat/use access (roles/discoveryengine.agentUser) to: ${grant.granted.join(', ')}.`,
              });
            }
            if (grant.failed.length) {
              result.fidelity.push({
                component: 'sharing',
                status: 'needs-review',
                detail: `Could not auto-grant access to ${grant.failed.map((f) => f.principal).join(', ')} — grant manually via console User permissions. (${grant.failed[0]?.error})`,
              });
            }
            emitLog(
              'warn',
              `  ${row.name}: not auto-shared (source chat access was not org-wide) — auto-granted ${grant.granted.length} principal(s), see report for any that failed.`,
            );
          }
        }
        // Pass the Reasoning Engine so verification ASKS the agent something instead of
        // only checking the resource exists — an agent that cannot reach its knowledge
        // sources must not report `verified`.
        const v = await verifyAgent(dest, saToken, create.agentId, undefined, {
          reasoningEngineId: adkReasoningEngineId,
          // Only demand retrieval from agents we actually gave knowledge to.
          expectsGrounding: adkGroundedStoreCount > 0,
        });
        result.verified = v.verified;
        result.verifySample = v.sample;
        if (!v.verified && v.note) {
          result.fidelity.push({
            component: 'verification',
            status: 'needs-review',
            detail: `The migrated agent was created but did not pass a live probe: ${v.note}.`,
          });
          emitLog('warn', `  ${row.name}: verification failed — ${v.note}`);
        }
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
