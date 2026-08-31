import { clientCredsToken } from './auth/microsoft.js';
import { recoverSharePointUrlAcrossEnvs } from './services/sharePointUrlRecovery.js';
import { getSaToken, serviceAccountEmail } from './auth/google.js';
import { logger } from './logger.js';
import { clearAwaitingHuman, emitToolEnd, emitToolStart } from './services/runSignals.js';
import { extractAgent, fetchFileAttachmentBytes, resolveSystemUserEmail } from './services/dataverse.js';
import { findCandidates } from './services/graphSearch.js';
import { resolveShareUrlSmart, downloadDriveItemBytes } from './services/graphFiles.js';
import { buildOrganizationProfile, destinationDomainsOf } from './services/organizationProfile.js';
import { createAgent, defaultDestination, resolveDestination, projectReachable, publishAgent, shareAgent, ensureAgentAccess, effectiveGeminiProject, type CreateOutcome } from './services/gemini.js';
import { preflightConnectors } from './services/connectorPreflight.js';
import { hasDedicatedToolModule } from './connectors/toolModule.js';
import { findCoverage } from './connectors/coverage.js';
import { findEquivalence, surfaceForConnector } from './connectors/equivalence.js';
import { resolveProjectNumber } from './services/adkDeployer.js';
import { listConnectorCredentials } from './db/repos/connectorCredentials.js';
import { uploadAgentFile, updateAgentFiles, getAgent, readAgentFiles, mimeTypeForFile, type AgentFile } from './services/geminiAgentFiles.js';
import { mapAgent } from './services/mapper.js';
import { applyPerUserAuth } from './services/userConnectorAuth.js';
import { resolveConnectorSecrets, buildLiveConnectorSpecsDetailed, agentConnectorIds } from './services/connectorToolBuilder.js';
import { resolveSurfaceTarget, SURFACE_EQUIVALENTS } from './db/repos/agentSurfaceChoice.js';
import { connectorsSharingCredentials, connectorSecretId } from './services/connectorCredentials.js';
import { getAgentConnectorIdentity } from './db/repos/agentConnectorIdentity.js';
import { readinessFor } from './connectors/readiness.js';
import { buildBoundToolSpecs } from './connectors/boundToolSpec.js';
import { resolveOpIndex, type CaptureContext } from './connectors/captureOpIndex.js';
import { REGISTRY_BY_ID } from './connectors/registry.js';
import { needsAclAcknowledgement, aclDisclosureFor } from './services/aclDisclosure.js';
import { migrateSharePointToDataStore } from './services/sharePointMigrator.js';
import type { SharePointMigrationResult } from './services/sharePointMigrator.js';
import { migrateConfluenceToDataStore, type ConfluenceCreds, type ConfluenceMigrationResult } from './services/confluenceMigrator.js';
import {
  migrateDataverseSnapshot,
  migrateSharePointDriveItem,
  migrateFileToDocumentStore,
  type DataverseSnapshotResult,
} from './services/knowledgeDataStoreExecutor.js';
import { resolveTableSearchTarget, type TableSearchTarget } from './services/dataverseTableExport.js';
import { attachDataStoreToEngine, dataStoreExists, dataStoreResourcePath } from './services/geminiDataStore.js';
import { getConnectorOperation, getConnectorDataStores } from './services/geminiConnector.js';
import { getKnowledgeConnector, markKnowledgeConnectorStatus } from './db/repos/knowledgeConnectors.js';
import { firstWebsiteSource, publishAgentToGallery } from './services/adkDeployer.js';
import { ensureSecretInProject, upsertSecretIfChanged } from './services/secretManager.js';
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
import { saveRawAgent, rawLandingEnabled, rawRetentionDays } from './db/repos/rawAgents.js';
import {
  attributeMemory,
  migrateAgentMemory,
  readEnvironmentMemory,
  unattributedMemoryNote,
} from './services/memoryExtract.js';
import type { MemoryFactIR } from './services/memory.js';
import { getIdentityMap } from './db/repos/identityMap.js';
import {
  buildPermissionHandoff,
  isOrgWideChat,
  permissionFidelityNotes,
  resolvePermissions,
} from './services/identityMap.js';
import type { AgentIR, FidelityNote, GeminiDestination, IdentityMapOverrides, KnowledgeSourceIR, MigrationResult, PermissionResolution, ProgressEvent, ResolvedPlan, ResolvedPrincipal } from './types.js';

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
    // Table resolution lives in the executor: resolveTableSearchTarget follows the real
    // Dataverse join (`dvtablesearch` → `dvtablesearchentity` → `entitylogicalname`) rather
    // than matching the captured key against table DISPLAY names, which could never match —
    // that key is an arbitrary generated name, and treating it as an EntitySetName is why
    // every table-search source failed with a misleading "EntityDefinitions lookup failed"
    // (confirmed live 2026-08-07).
    //
    // ONE Copilot source can name SEVERAL tables ("FAQ Entry, CF ICP Profile" is two) — the
    // join can return more than one dvtablesearchentity row. Each needs its own structured
    // data store (different schemas cannot share one), so resolve here first and expand
    // into one migrateDataverseSnapshot call per table rather than letting the executor
    // silently pick just the first (confirmed live 2026-08-12 that it otherwise does).
    const capturedRef = (src.references?.[0] ?? src.reference ?? '').trim();
    const { targets } = capturedRef
      ? await resolveTableSearchTarget(envUrl, dvToken, capturedRef)
      : { targets: [] as TableSearchTarget[] };

    if (targets.length <= 1) {
      const snap = await migrateDataverseSnapshot(dest, saToken, dvToken, envUrl, sourceId, src);
      out.push({ src, snap });
      continue;
    }

    for (const target of targets) {
      const snap = await migrateDataverseSnapshot(dest, saToken, dvToken, envUrl, sourceId, src, target);
      // Name the resolution after the TABLE so the fidelity report says which one
      // succeeded or failed, instead of one combined entry for a multi-table source.
      out.push({ src: { ...src, name: `${src.name} → ${target.entitySetName}` }, snap });
    }
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
 * Handles a single file, a folder that holds one file, and a folder of several files
 * (each copied, bounded and reported). A source that resolves to nothing, or to a whole
 * site/library, is left in `remaining` for the native-connector path to attempt (which,
 * per the above, is not currently expected to work either — but there is no other
 * automated option yet for a whole-site reference).
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

      // A FOLDER of several files is deliberately NOT copied.
      //
      // The rule the product follows: a source that names ONE FILE is fetched and stored
      // (indexed, semantically searchable); anything broader — a folder, a library, a
      // whole site — is served by the live SharePoint tools instead. Copying a folder
      // would produce a point-in-time duplicate of content that goes stale, drop
      // SharePoint's permissions on every file in it, and grow without limit; the tools
      // read the same files on demand, current, scoped to the folder the author named.
      //
      // 'not-found' also falls through, since there is nothing to fetch either way.
      // 'file' and 'folder-single-file' are BOTH a confident single-file match — see
      // graphFiles.ts's resolveShareUrlSmart, where a folder holding exactly one file IS
      // that file as far as the author was concerned.
      if ((shared.kind !== 'file' && shared.kind !== 'folder-single-file') || !shared.item) {
        remaining.push(src);
        logs.push({
          level: 'info',
          text: `    "${src.name}": ${shared.kind === 'not-found' ? 'could not be resolved' : 'is a folder, not one file'} — not copied; the migrated agent reads it live through its SharePoint tools instead.`,
        });
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
  /**
   * Cooperative stop, read at agent boundaries. Cooperative rather than immediate
   * because killing mid-agent would leave a half-created Gemini agent that no later
   * run could reason about — the same reason a failed insert is retryable.
   */
  shouldStop: () => boolean = () => false,
): AsyncGenerator<ProgressEvent> {
  const q = new EventQueue();
  const run = execute(session, plan, (e) => q.push(e), shouldStop)
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

/**
 * Record which identity a connector's tools will run as, onto the result the report reads.
 *
 * The orchestrator already logs this; the log is not the record. Which mailbox a migrated
 * agent acts as is the first thing an admin asks after "did it work", and it was surviving
 * only as long as the run's own screen stayed open.
 *
 * A no-op if the connector was never wired for this agent, so an identity can never invent
 * a capability the agent does not have.
 */
function markActsAs(result: MigrationResult, connectorName: string, identity: string): void {
  const entry = result.connectorsWired?.find((c) => c.name === connectorName);
  if (entry) entry.actsAs = identity;
}

async function execute(
  session: Session,
  plan: ResolvedPlan,
  emit: Emit,
  shouldStop: () => boolean = () => false,
): Promise<void> {
  /** Set the first time a stop is honoured, so the summary can say so truthfully. */
  let stoppedEarly = false;
  const project = session.geminiProject ?? '';
  const gEmail = session.gEmail ?? '';
  const appUserId = session.appUserId ?? DEFAULT_APP_USER_ID;
  const runId = newId();
  const results: MigrationResult[] = [];
  // A new run supersedes whatever the last one was waiting for. Leaving a stale handoff
  // tells the operator to act on something already dealt with, and an indicator that has
  // cried wolf twice stops being read at all.
  await clearAwaitingHuman(session.id);

  // Resolve each source environment to its Gemini destination. If the customer
  // mapped the environment (environmentMap), route there; otherwise use the
  // connected project's default engine — DISCOVERED from the project (see below)
  // so the tool works against any client's project without a hardcoded engine id.
  const envMap = plan.destination.environmentMap ?? {};
  let resolvedDefault = defaultDestination(project); // sync fallback; replaced after auth
  const targetFor = (envUrl: string): GeminiDestination => {
    const dest = envMap[envUrl] ?? resolvedDefault;
    // Refuse rather than deploy into a destination that cannot exist. The route validates
    // this too, but a plan can reach here from a resumed session, so "checked at the edge"
    // is not the same as "cannot happen" — and the failure this prevents costs a built,
    // billable Reasoning Engine to discover.
    if (!dest?.project?.trim() || !dest?.engine?.trim()) {
      throw new Error(
        `No Gemini project/app is set for ${envUrl}. Choose both on the Select & Map ` +
          'Environments step — migrating without them would deploy an engine that cannot be registered.',
      );
    }
    return dest;
  };

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

  /**
   * Per-principal resolution trace for the sharing step — one line per person,
   * showing exactly how (or whether) they were resolved to a Google identity.
   * The summary log ("auto-granted N principal(s)") only ever showed a count;
   * debugging a wrong or missing grant meant reading the final JSON report.
   * This surfaces the same detail live, in the stream, while the run is
   * happening.
   */
  const logIdentityResolution = (agentName: string, resolution: PermissionResolution): void => {
    const all: { role: string; r: ResolvedPrincipal }[] = [
      ...(resolution.owner ? [{ role: 'owner', r: resolution.owner }] : []),
      ...resolution.coauthors.map((r) => ({ role: 'editor', r })),
      ...resolution.viewers.map((r) => ({ role: 'viewer', r })),
      ...resolution.chatPrincipals.map((r) => ({ role: 'chat', r })),
    ];
    for (const { role, r } of all) {
      const label = r.source.email || r.source.displayName || r.source.id;
      if (r.google) {
        emitLog('info', `    ${agentName}: [${role}] ${label} -> ${r.google.email} (${r.via})`);
      } else {
        emitLog('warn', `    ${agentName}: [${role}] ${label} UNMATCHED — ${r.reason ?? 'no reason recorded'}`);
      }
    }
  };

  /** Per-principal outcome of the actual Google API grant calls — separate from
   *  resolution above: a principal can resolve to a real Google identity and
   *  still fail here (no licence, engine role grant denied, etc). */
  const logGrantResult = (
    agentName: string,
    grant: { granted: string[]; failed: { principal: string; error: string; failedAt: string }[] },
  ): void => {
    for (const principal of grant.granted) {
      emitLog('ok', `    ${agentName}: granted ${principal}`);
    }
    for (const f of grant.failed) {
      emitLog('fail', `    ${agentName}: FAILED to grant ${f.principal} at step "${f.failedAt}" — ${f.error}`);
    }
  };

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
  /**
   * Every environment a lost SharePoint address might be recoverable from, the agent's own
   * first.
   *
   * SharePoint is tenant-wide while Dataverse environments are not, so the agent that kept
   * an address is often in a DIFFERENT environment from the one that lost it (measured:
   * "TestingPermissions" is address-less in one environment and fully addressed in
   * another). An environment we cannot get a token for is skipped, not fatal — recovery is
   * best-effort by design.
   */
  const spRecoveryEnvs = async (ownEnvUrl: string): Promise<Array<{ envUrl: string; dvToken: string }>> => {
    const urls = [ownEnvUrl, ...(session.environments ?? []).map((e) => e.url).filter((u) => u !== ownEnvUrl)];
    const out: Array<{ envUrl: string; dvToken: string }> = [];
    for (const envUrl of urls) {
      try {
        out.push({ envUrl, dvToken: await tokenFor(envUrl) });
      } catch {
        // no access to that environment; the others can still answer
      }
    }
    return out;
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
  const destinationDomains = destinationDomainsOf(orgProfile);
  if (orgProfile.ownedDomains.length) {
    emitLog('info', `Org profile: owned domains [${orgProfile.ownedDomains.join(', ')}] via ${orgProfile.domainSources.join(', ') || 'none'}`);
  }
  const identityOverrides: IdentityMapOverrides = await getIdentityMap(
    appUserId,
    session.tenantId ?? '',
    session.geminiProject ?? '',
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
  // A record stored against ANOTHER project is not unusable — it is un-copied. This used to
  // filter those records out entirely, which pinned a customer's credentials to whichever
  // project happened to be connected when they were first saved: point the run at a
  // different project and every connector silently reported as unconfigured, its tools were
  // never wired, and the report blamed a missing credential that was sitting in Secret
  // Manager the whole time. Credentials belong to a CUSTOMER; a project is only where copies
  // of them live.
  //
  // So the records are kept and their secrets are brought across from wherever they actually
  // are, BEFORE resolveConnectorSecrets reads the deploy project. Best-effort throughout: a
  // secret that cannot be copied simply is not found later, which is the same outcome as
  // before minus the silent discard.
  const destProject = effectiveGeminiProject(session.geminiProject);
  // ONE record per connector. The same connector can hold a record in several projects —
  // re-entering a credential while a different project is connected writes a second one —
  // and the maps built below are keyed by connector id, so without a decision here whichever
  // row happened to come back last would win silently. Prefer the deploy project's own
  // record, then the most recently saved: the newest is what the customer last typed.
  const allConnectorRecords = await listConnectorCredentials(appUserId).catch(() => []);
  const bestByConnector = new Map<string, (typeof allConnectorRecords)[number]>();
  for (const rec of allConnectorRecords) {
    const cur = bestByConnector.get(rec.connectorId);
    if (!cur) { bestByConnector.set(rec.connectorId, rec); continue; }
    const recWins =
      (rec.project === destProject && cur.project !== destProject)
      || (rec.project === destProject === (cur.project === destProject)
          && +new Date(rec.updatedAt ?? 0) > +new Date(cur.updatedAt ?? 0));
    if (recWins) bestByConnector.set(rec.connectorId, rec);
  }
  const durableConnectorRecords = [...bestByConnector.values()];
  if (destProject) {
    const strays = durableConnectorRecords.filter((c) => c.project && c.project !== destProject);
    if (strays.length) {
      emitLog(
        'info',
        `Bringing ${strays.length} connector credential(s) into ${destProject} from `
        + `${[...new Set(strays.map((c) => c.project))].join(', ')}`,
      );
      await Promise.all(strays.flatMap((c) => {
        // Prefer the ids the credential was ACTUALLY written under; fall back to the
        // computed name for records saved before secretIds were recorded.
        const ids = Object.values(c.secretIds ?? {});
        const names = ids.length
          ? ids
          : Object.keys(c.fields ?? {}).map((f) => connectorSecretId(c.connectorId, f, credentialScope(session)));
        return names.map((secretId) =>
          ensureSecretInProject(saToken, c.project, destProject, secretId)
            .catch(() => undefined),
        );
      }));
    }
  }
  const durableConnectorIds = durableConnectorRecords.map((c) => c.connectorId);
  /** Where each connector's credential was saved, for later cross-project syncs. */
  const credentialSourceProject = new Map<string, string>(
    durableConnectorRecords.filter((c) => c.project).map((c) => [c.connectorId, c.project]),
  );
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
  // CUSTOM connectors have no registry entry and never will, so they need resolving from
  // the customer's own environment before the (synchronous) spec builder runs. Without
  // this a custom connector that binds, and whose credential is stored, still produced no
  // spec — and the report then said its tools were "NOT migrated — no credentials were
  // configured", which was wrong twice over. Proven on a live run of "Hubspot agentt":
  // four operations rebuilt as exact API calls, four operations reported lost.
  const customConnectorIds = new Set<string>();
  const customConnectorNames = new Map<string, string>();
  for (const id of savedConnectors) {
    if (REGISTRY_BY_ID.has(id)) continue;
    const unit = plan.units[0];
    const ctx = unit ? captureCtxFor(unit.envUrl) : undefined;
    if (!ctx) continue;
    const idx = await resolveOpIndex(id, ctx).catch(() => undefined);
    if (idx?.vendorBinding) {
      customConnectorIds.add(id);
      customConnectorNames.set(id, idx.displayName);
    }
  }
  const { specs: liveConnectorSpecs, unsupported: unsupportedConnectorIds } =
    buildLiveConnectorSpecsDetailed(savedConnectors, secretIdOpts, customConnectorIds, customConnectorNames);
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
  // Announce capture explicitly. Landing unredacted customer payloads must never be a
  // silent side effect of a config value nobody remembers setting.
  if (rawLandingEnabled()) {
    emitLog('info', `Raw payload capture is ON — verbatim Copilot payloads retained for ${rawRetentionDays()} day(s), then auto-deleted`);
  }
  let extracted = 0;
  await mapPool(workItems, CONCURRENCY, async (item) => {
    // Stop checkpoint. Skipping an agent we have not started is free — nothing exists
    // in Gemini to reason about later — so Phase 1 honours a stop per item.
    if (shouldStop()) {
      stoppedEarly = true;
      return;
    }
    // Phase 1 is the longest silence in a run — every agent is read from Dataverse before
    // anything appears on screen. The id is the Copilot source id, the same key the UI
    // already uses for its rows, so the step can honestly name which agent it is on.
    emitToolStart(emit, 'extract', `Reading ${item.bot.name} from Copilot Studio`, `agent:${item.bot.botid}`);
    try {
      const token = await tokenFor(item.envUrl);
      // Land the verbatim payload before parsing, when the operator has opted in. The sink
      // is fire-and-forget: `saveRawAgent` never throws and never blocks, so a diagnostic
      // capture cannot slow or fail the extraction it exists to explain.
      const ir = await extractAgent(item.envUrl, token, item.bot, (raw) => {
        void saveRawAgent({
          appUserId,
          tenantId: session.tenantId,
          runId,
          envUrl: raw.envUrl,
          sourceId: raw.sourceId,
          sourceName: raw.sourceName,
          components: raw.components,
          botRecord: raw.botRecord,
          disabledComponentNames: raw.disabledComponentNames,
        });
      });
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
      void cacheAgentIR(appUserId, item.envUrl, ir, mapped, session.tenantId);
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
      // Thin content is a real caveat, not a failure: the agent extracted fine, there was
      // just little in it to extract. Reporting it as failed would blame the tool for what
      // the source actually contains, so it stays ok with the caveat in the message.
      emitToolEnd(
        emit,
        'extract',
        true,
        ir.thinContent
          ? `Extracted ${item.bot.name} — thin content, needs manual authoring`
          : `Extracted ${item.bot.name} · ${ir.topics.length} topic(s), ${ksTotal} knowledge source(s)`,
        `agent:${item.bot.botid}`,
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
      emitToolEnd(
        emit,
        'extract',
        false,
        `Extract failed for ${item.bot.name}: ${(err as Error).message}`,
        `agent:${item.bot.botid}`,
      );
    } finally {
      extracted++;
      emitProg(5 + Math.round(45 * (extracted / total)), `Extracting ${extracted}/${total}`);
    }
  });

  const staged = await listStaged(appUserId, runId, 'staged');
  emitLog('info', `Phase 1 complete: ${staged.length}/${total} staged in DB`);

  // ── Agent memory: read once per environment ───────────────────────────────
  //
  // `intelligentmemory` has no bot relationship, so this cannot be folded into per-agent
  // extraction — it is one read per environment, split afterwards. `undefined` means the
  // table could not be read (an environment older than the feature returns 404), which
  // must stay distinguishable from "this customer has no memory": reporting the first as
  // the second would claim we checked when we did not.
  const envMemory = await (async () => {
    const byAgent = new Map<string, MemoryFactIR[]>();
    let unattributed = 0;
    let anyRead = false;
    for (const unit of plan.units) {
      const facts = await readEnvironmentMemory(unit.envUrl, await tokenFor(unit.envUrl));
      if (facts === undefined) continue;
      anyRead = true;
      const split = attributeMemory(facts, unit.bots.map((b) => b.botid));
      for (const [botId, list] of split.byAgent) byAgent.set(botId, [...(byAgent.get(botId) ?? []), ...list]);
      unattributed += split.unattributed.length;
    }
    if (!anyRead) return undefined;
    const total = [...byAgent.values()].reduce((n, l) => n + l.length, 0) + unattributed;
    if (total) {
      emitLog('info', `Agent memory: ${total} remembered fact(s) — ${total - unattributed} tied to a migrating agent, ${unattributed} not.`);
    }
    return { byAgent, unattributed };
  })();

  // The operator's Microsoft→Google user mapping is what lets a private memory move at
  // all: without a destination identity there is no scope narrow enough to hold it.
  const memoryIdentityMap = new Map(
    Object.entries(identityOverrides.users).map(([ms, google]) => [ms.toLowerCase(), String(google)]),
  );

  // WHO IS ASKING, in SOURCE terms. Gemini hands the deployed agent a destination identity
  // (ben@newco.com); the mailbox and the Dataverse account live in the source tenant
  // (ben@oldco.co). Guessing the link from the local part is not safe — in the live test
  // tenant `ben@` matches three different domains and `alex@` three more, so a guess reads
  // a stranger's mail. The operator already stated the pairing on the Map users screen, so
  // use that: it is the authoritative answer to exactly this question, reversed.
  const callerIdentityMap: Record<string, string> = {};
  for (const [ms, google] of Object.entries(identityOverrides.users)) {
    if (google) callerIdentityMap[String(google).toLowerCase()] = ms;
  }

  // Memory that belongs to no migrating agent still has to reach the report — it is the
  // difference between "this agent kept its personalization" and "the personalization
  // stayed in Copilot". Carried onto every agent in the run because the report is
  // per-agent and the note itself says it is environment-wide.
  const envMemoryNotes: FidelityNote[] = envMemory?.unattributed
    ? [unattributedMemoryNote(envMemory.unattributed)]
    : [];

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

  // The blocking acknowledgement gate was REMOVED 2026-08-23 at the product owner's
  // direction, twice stated. A run that would invert a knowledge source's permissions no
  // longer stops to collect a separate consent; the disclosure is made in the UI at the
  // point of action, on the button that starts the run.
  //
  // What deliberately did NOT go with it is the RECORD. Every affected source is still
  // written to the fidelity report below, because the report is the only place a wrongly
  // exposed document can ever announce itself: the inversion is silent and permanent, and
  // there is no later screen where someone discovers that an HR file became readable by
  // everyone the agent is shared with. Dropping the gate is a product decision about
  // friction; dropping the record would be overclaiming fidelity, which this project's
  // rules forbid regardless of who asks.
  //
  // `plan.acknowledgeAclLoss` is still honoured where it arrives — it upgrades the report
  // wording from "disclosed" to "explicitly acknowledged" — but nothing requires it, and no
  // run stops for its absence.

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
          `${item.detail} ${
            plan.acknowledgeAclLoss
              ? 'This was explicitly acknowledged before the migration ran.'
              : 'This was disclosed before the run started; no separate acknowledgement is collected.'
          } It cannot be changed without deleting and re-indexing the data store.`,
      })),
    );
  }
  if (aclFlagged.length) {
    // A dry run reaches here WITHOUT an acknowledgement (the gate above skips it), so
    // saying "acknowledged" would credit the operator with a consent they never gave —
    // and this log is what someone reads later to decide whether the loss was accepted.
    emitLog(
      'warn',
      plan.acknowledgeAclLoss
        ? `Permission loss acknowledged for ${aclFlagged.length} agent(s) — proceeding. Each affected ` +
            'source is recorded in the fidelity report.'
        : `${aclFlagged.length} agent(s) lose source permissions — proceeding. Anyone the migrated ` +
            'agent is shared with can read what it indexed. Each affected source is in the fidelity report.',
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
        fidelity: [...row.fidelity, ...(aclNotesBySourceId.get(row.sourceId) ?? []), ...envMemoryNotes],
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
    // Stop checkpoint, BEFORE anything is created for this agent. The row stays staged,
    // so a later run resumes it from the insert rather than re-reading Copilot.
    if (shouldStop()) {
      stoppedEarly = true;
      return;
    }
    const result: MigrationResult = {
      sourceId: row.sourceId,
      name: row.name,
      created: false,
      deployed: false,
      shared: false,
      // Acknowledged permission loss travels with the agent's own report, not just the run
      // log — the report is what someone reads months later.
      fidelity: [...row.fidelity, ...(aclNotesBySourceId.get(row.sourceId) ?? []), ...envMemoryNotes],
      // Carried from the staged row so the report can lead with what the agent DOES
      // rather than only that it was created. A created agent reproducing 4 of 13
      // capabilities is not a successful migration, and only this ratio says so.
      ...(row.topicsSummary
        ? {
            capabilities: {
              total: row.topicsSummary.capabilities,
              exact: row.topicsSummary.fullFidelity,
            },
          }
        : {}),
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
              (snap.error ? ` — ${snap.error}` : '') +
              // WHY the rows failed, not just how many. Discovery Engine returns per-row
              // errorSamples and they were reconciled all the way up to this result, then
              // dropped here — so a 0/198 import printed a count and no cause, and the
              // only way to learn anything was to re-run with a debugger. A failure we
              // captured and chose not to show is worse than one we never captured.
              (snap.failureSamples?.length
                ? ` — ${snap.failureSamples.slice(0, 2).join('; ')}`
                : ''),
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
            // A data store existing is not the same as its rows actually being searchable —
            // previously only schemaNotes surfaced here, so a 100%-row-failure table (store
            // created, every row rejected on import) produced NO fidelity note at all and
            // looked identical to a fully-successful one in the customer-facing report.
            if (snap.failed) {
              result.fidelity.push({
                component: `knowledge:${src.name}`,
                status: snap.succeeded ? 'partial' : 'needs-review',
                detail:
                  `${snap.succeeded}/${snap.attempted} row(s) indexed, ${snap.failed} failed to import into Discovery Engine.` +
                  (snap.failureSamples?.length ? ` Sample errors: ${snap.failureSamples.join(' || ')}` : ' No per-row error detail was returned by the import operation.'),
              });
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
      // Some sources kept an opaque config-record id instead of a URL, so copy mode has
      // no address to resolve and the whole source drops to the native connector, which
      // returns no content. The address usually exists in the customer's own Dataverse on
      // a SIBLING agent that stored the same source properly — recover it before copy mode
      // runs, and say where it came from. See services/sharePointUrlRecovery.ts.
      const spSourcesForCopy: KnowledgeSourceIR[] = [];
      // A recovered source is a COPY of the IR object with the address filled in, and
      // everything downstream ("was this source covered by copy mode?") compares sources
      // by object identity. Without this map a recovered source would be reported as
      // covered AND as still needing the native connector's caveat.
      const originalOf = new Map<KnowledgeSourceIR, KnowledgeSourceIR>();
      // A recovered address must reach the TOOLS too, not only copy mode. Copy mode
      // declines anything broader than one file, so a recovered FOLDER address would
      // otherwise be recovered and then dropped — the agent gets neither a copy nor a
      // tool scope, which is the same silent nothing the recovery existed to fix.
      const recoveredUrlOf = new Map<KnowledgeSourceIR, string>();
      for (const src of spConnectorSources) {
        const have = (src.reference ?? src.references?.[0] ?? '').trim();
        if (/^https?:\/\//i.test(have)) {
          spSourcesForCopy.push(src);
          continue;
        }
        const rec = await recoverSharePointUrlAcrossEnvs(await spRecoveryEnvs(row.envUrl), src.name);
        if (rec.status === 'recovered') {
          const patched: KnowledgeSourceIR = { ...src, reference: rec.url };
          originalOf.set(patched, src);
          recoveredUrlOf.set(src, rec.url);
          spSourcesForCopy.push(patched);
          result.fidelity.push({
            component: `knowledge:${src.name}`,
            status: 'needs-review',
            detail:
              `"${src.name}" stored no address — Copilot kept only an internal configuration id for it. ` +
              `The same source is attached to another agent in this environment (${rec.fromSchemaName}) which DID keep the ` +
              `address, so that one was used: ${rec.url}. This is a name match, not an identifier match — confirm it is the ` +
              'same file before relying on the answers.',
          });
          emitLog('ok', `    "${src.name}": no address stored; recovered one from a sibling knowledge source and using copy mode.`);
        } else {
          if (rec.status === 'ambiguous') {
            result.fidelity.push({
              component: `knowledge:${src.name}`,
              status: 'needs-review',
              detail:
                `"${src.name}" stored no address, and other agents in this environment reference ${rec.urls.length} DIFFERENT ` +
                `addresses under that same name (${rec.urls.join(', ')}). Picking one could ground this agent on the wrong ` +
                'file, so none was chosen — set the correct source manually.',
            });
            emitLog('warn', `    "${src.name}": no address stored and ${rec.urls.length} different candidates share the name — not guessing.`);
          }
          spSourcesForCopy.push(src); // unchanged; copy mode will skip it as before
        }
      }

      let spCopyModeResolved: SharePointCopyModeResolution[] = [];
      if (spConnectorSources.length) {
        const copyMode = await resolveSharePointCopyModeSources(dest.project, saToken, await graphToken(), row.sourceId, spSourcesForCopy);
        // Map any recovered clone back to the IR object the rest of the run holds.
        spCopyModeResolved = copyMode.resolved.map((r) => ({ ...r, src: originalOf.get(r.src) ?? r.src }));
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
      /** The address to use for a source: its own, or the one recovered for it. */
      const spAddressOf = (s: KnowledgeSourceIR): string =>
        recoveredUrlOf.get(s) ?? (s.reference ?? s.references?.[0] ?? '').trim();
      const spGraphSources = ks.filter(
        (s) => s.kind !== 'FileUpload' && /sharepoint\.com/i.test(spAddressOf(s)),
      );
      // EVERY named source becomes a tool scope, not just the one we crawl. An agent with
      // two SharePoint sources attached could read both in Copilot; scoping its tools to
      // sources[0] silently removed the second while the report still said SharePoint was
      // migrated. The union of the author's own paths is exactly the source agent's reach —
      // one path wider (a common parent, the whole site) is not.
      // A source copy mode already fetched is NOT a tool scope. It named one file, so it
      // is stored and searchable; handing that same file path to the folder tools would
      // give them a scope with no children to list. Broad sources — the ones copy mode
      // deliberately left alone — are exactly what the tools are for.
      const spUncovered = spGraphSources.filter((s) => !spCopyModeCoveredSrcs.has(s));
      const spScopeUris = [
        ...new Set(
          spUncovered
            .map(spAddressOf)
            .filter((u) => /^https?:\/\//i.test(u)),
        ),
      ];
      // Microsoft app credentials come from the shared ms_graph group — the same set
      // every Microsoft connector uses, saved once by the customer.
      const msCreds = resolvedConnectors.find((c) =>
        c.connectorId === 'shared_sharepointonline' || c.connectorId === 'shared_onedrive',
      )?.fields;
      const spHasCreds = Boolean(msCreds?.tenant_id && msCreds?.client_id && msCreds?.client_secret);
      // Broad sources are TOOL-SERVED, not bulk-copied.
      //
      // This block used to crawl the whole site and index everything under it. That is a
      // point-in-time duplicate that goes stale, strips SharePoint's permissions from
      // every file it copies, and can be far larger than what the author attached. With
      // the same credentials the agent gets live, folder-scoped list/read tools that
      // answer from the CURRENT file — so the crawl now runs only when those tools cannot
      // (no credentials), and specific FILES are still fetched and indexed by copy mode
      // above, which is what makes them semantically searchable.
      const spToolServed = spHasCreds && spScopeUris.length > 0;
      if (spToolServed) {
        spScopeUri = spScopeUris[0];
        emitLog(
          'info',
          `    SharePoint: ${spScopeUris.length} source(s) served by live tools (list/read, scoped to ${spScopeUris.length === 1 ? 'the folder' : 'the folders'} this agent named) — not bulk-copied.`,
        );
        for (const uri of spScopeUris) {
          result.fidelity.push({
            component: `knowledge:${uri}`,
            status: 'mapped',
            detail:
              'Reachable live: the migrated agent lists and reads files under this path through Microsoft Graph, using the ' +
              'app credentials you supplied, at question time. Content is current rather than a copy, and the tools cannot ' +
              'reach outside this path. Note the agent reads with the app identity, so it can see everything under the path ' +
              'regardless of who is asking.',
          });
        }
      } else if (spUncovered.length && dest.project && spHasCreds && /^https?:\/\//i.test(spAddressOf(spUncovered[0]))) {
        // Only ever crawl what copy mode did NOT already fetch; crawling a file we just
        // indexed would duplicate it into a second data store. And only with a real
        // address — an opaque config id here produced a crawl guaranteed to fail.
        spScopeUri = spAddressOf(spUncovered[0]);
        emitLog('info', `    SharePoint: crawling ${spScopeUri} for grounding…`);
        preSpResult = await migrateSharePointToDataStore(
          dest.project, saToken, row.mapped.ir.sourceId,
          { tenantId: msCreds!.tenant_id, clientId: msCreds!.client_id, clientSecret: msCreds!.client_secret, siteUrl: spScopeUri },
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
            // Spaces the agent was grounded on that we could not find. When ALL of them
            // fail the crawl returns an error and the customer is told; when only SOME do,
            // the crawl succeeds and — until now — the missing ones appeared nowhere but a
            // server log. Observed live 2026-08-12: a run warned about unmatched spaces,
            // then reported "7 page(s) ready" and finished green. An agent that deploys
            // successfully while a knowledge source it was grounded on is silently absent
            // is the exact failure this pipeline exists to prevent.
            if (preCfResult.unmatchedSpaceNames?.length) {
              const names = preCfResult.unmatchedSpaceNames.join(', ');
              result.fidelity.push({
                component: 'knowledge:confluence',
                status: 'needs-review',
                detail:
                  `The source agent is grounded on Confluence space(s) we could not find: ${names}. ` +
                  'The other spaces were crawled and the agent migrated, so it will answer from LESS ' +
                  'content than the original. The space may have been renamed or deleted, or the ' +
                  'Confluence credential may not be able to see it — check before relying on this agent.',
              });
              emitLog('warn', `    Confluence: space(s) not found and NOT migrated: ${names}`);
            }
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
      // Tool names actually wired onto this agent, carried out to verification. Declared
      // here, beside the other verify inputs, because the bound-tool build happens in a
      // deeper block that verification cannot see into.
      let adkWiredToolNames: string[] = [];
      /** True once the ADK worker has told us the tools it really wired. */
      let workerReportedToolNames = false;
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
              // FIRST question, before any skip can fire: is the agent we would reuse still
              // there? Deleting an agent in the Gemini console leaves the source unchanged
              // and every data store healthy, so every other check below passes and the run
              // reports `already exists` about something that is gone.
              //
              // This check sat lower down and was jumped over by the no-snapshot early
              // return, which is exactly what happened live on 2026-08-13: two agents were
              // deleted in the console, both were reported "already exists - skipped", and
              // the API answered 404 for both ids at that very moment. A check that a
              // return statement can skip is not a check.
              const stillThere = await getAgent(dest, saToken, existing.agentId).catch(() => null);
              if (!stillThere) {
                emitLog(
                  'warn',
                  `  ${row.name}: the previously migrated agent (${existing.agentId}) no longer exists in Gemini - deleted outside this tool. Recreating it.`,
                );
                result.fidelity.push({
                  component: 'resync',
                  status: 'needs-review',
                  detail:
                    `The agent migrated earlier (id ${existing.agentId}) was not found in Gemini - it was deleted outside this tool. ` +
                    'It has been recreated, so its id has changed; update any link or bookmark that pointed at the old one.',
                });
              }
              const priorSnapshot = await getMigratedSnapshot(appUserId, row.envUrl, row.sourceId, dest);
              // An explicit force wins over every skip below. Drift only knows about the
              // SOURCE agent, so without this there is no way to push a change that
              // originates on OUR side — a corrected tool name, a newly wired connector —
              // onto an agent that is already migrated.
              if (plan.forceRedeploy) {
                emitLog('warn', `  ${row.name}: forced redeploy — deploying again even though the source is unchanged.`);
              } else if (!priorSnapshot && stillThere) {
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

              // Four independent reasons to redeploy: the source changed, its knowledge
              // broke, the agent itself is gone, or a human asked. forceRedeploy is last
              // because it is the only one that is a decision rather than an observation.
              if (stillThere && !drift.changed && !unhealthyFiles.length && !unhealthySharePoint.length && !plan.forceRedeploy) {
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
            //
            // The registry is no longer the ONLY authority. A CUSTOM connector can never
            // have a registry entry — it is the customer's own, named after whatever they
            // typed — but its published definition may still bind, so build the tools
            // first and treat "produced a real call" as support. Without this the report
            // would carry both a working tool and a `lost` note saying that same connector
            // is unsupported, and a customer reading a contradiction cannot know which
            // half to trust.
            const boundBuild = await buildBoundToolSpecs(row.mapped!.ir, captureCtxFor(row.envUrl), {
              dataverseOrgUrl: row.envUrl ?? '',
            });
            const boundConnectorIds = new Set(boundBuild.byConnector.keys());
            const unsupportedForThisAgent = [...usedConnectorIds].filter(
              (id) => !REGISTRY_BY_ID.has(id) && !boundConnectorIds.has(id),
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
              // "Blocked" means this exact call (with the source agent's own fixed
              // arguments) cannot be reproduced — NOT that the capability is gone. Every
              // registered connector still gets a live tool wired below regardless of
              // readiness (buildLiveConnectorSpecsDetailed builds one unconditionally), and
              // for connectors like Google Drive that tool is a full hand-written
              // replacement (connector_tools/google_drive.py's 12 actions), not a
              // degraded stand-in. Reporting these as flatly `lost` claimed the migrated
              // agent could no longer do the thing at all, when in fact it can — just by
              // letting the model choose the arguments each time instead of replaying the
              // ones baked into the original flow. That is a real, worth-reporting
              // difference, but it is `partial`, not `lost`.
              const hasLiveTool = liveConnectorSpecs.some((c) => c.id === connectorId);
              for (const blockedOp of readiness.blocked) {
                // A judged operation gets its real verdict: the TOOL that serves it, whether
                // it was proven live, and what is actually narrowed. The generic wording
                // below ("decides its own arguments at conversation time") is true but says
                // nothing a customer can check — and for connectors with a hand-written
                // module it understates the case badly, because a purpose-built tool is not
                // a degraded replay of the original call. See connectors/coverage.ts.
                const cov = findCoverage(connectorId, blockedOp.operationId);
                if (cov && cov.fidelity !== 'lost' && cov.tool) {
                  result.fidelity.push({
                    component: `connector:${connectorId}:${blockedOp.operationId}`,
                    status: cov.fidelity === 'exact' ? 'mapped' : 'partial',
                    detail:
                      `"${cov.label}" (${blockedOp.operationId}) is served by the ` +
                      `${cov.tool} tool${cov.verified ? ', proven against a real tenant' : ''}. ` +
                      (cov.reason ? `${cov.reason}` : 'No information is lost.'),
                  });
                  emitLog(
                    'info',
                    `  ${row.name}: ${connectorId}.${blockedOp.operationId} -> ${cov.tool}` +
                      ` (${cov.fidelity}${cov.verified ? ', verified' : ''}).`,
                  );
                  continue;
                }
                result.fidelity.push({
                  component: `connector:${connectorId}:${blockedOp.operationId}`,
                  status: hasLiveTool ? 'partial' : 'lost',
                  detail: hasLiveTool
                    ? `This agent called "${blockedOp.operationId}" on ${readiness.displayName} with fixed, ` +
                      `pre-set arguments. The migrated agent has a live ${readiness.displayName} tool and can ` +
                      `still do this, but decides its own arguments at conversation time instead of replaying ` +
                      `the original ones. ${blockedOp.reason}`
                    : `This agent calls "${blockedOp.operationId}" on ${readiness.displayName}, which the ` +
                      `migrated agent cannot reproduce. ${blockedOp.reason}`,
                });
                emitLog(
                  hasLiveTool ? 'info' : 'warn',
                  hasLiveTool
                    ? `  ${row.name}: ${connectorId}.${blockedOp.operationId} covered by the live tool, not an exact-argument reproduction — reported as partial.`
                    : `  ${row.name}: ${connectorId}.${blockedOp.operationId} cannot be reproduced — reported as lost.`,
                );
              }
            }

            const applicable = liveConnectorSpecs.filter((c) => usedConnectorIds.has(c.id));
            // Carry this onto the result, not just the log. The log is the only place the
            // connector/tool counts existed, and it does not survive the screen being
            // closed or the container being restarted — so the report, read months later,
            // could not say what the migrated agent could actually do.
            //
            // Count from `opsByConnector`, NOT from `c.operations`. The specs coming out of
            // buildLiveConnectorSpecsDetailed never carry operations -- they are attached
            // further down, when `scopedConnectors` is derived -- so reading them here ran
            // ~25 lines too early and every connector reported `0 tools`, with the header
            // summing to "0 tools reproduced across 5 connectors" on a run that reproduced
            // plenty. Zero was not a missing value the report could flag: it was a wrong one.
            result.connectorsWired = applicable.map((c) => ({
              name: c.name,
              toolCount: opsByConnector.get(c.id)?.length ?? 0,
            }));
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
            // (Built above, before the unsupported-connector pass, so that pass can tell a
            // custom connector that binds from one that genuinely has no support.)
            result.fidelity.push(...boundBuild.notes);
            for (const note of boundBuild.notes) {
              if (note.status === 'lost') emitLog('warn', `  ${row.name}: ${note.detail}`);
            }

            let scopedConnectors = applicable.map((c) => {
              const withOps = opsByConnector.has(c.id) ? { ...c, operations: opsByConnector.get(c.id) } : c;
              const bound = boundBuild.byConnector.get(c.id);
              const withBound = bound?.length ? { ...withOps, boundOperations: bound } : withOps;
              return /sharepoint|onedrive/i.test(withBound.kind) && (spScopeUris.length || spScopeUri)
                ? { ...withBound, scopeUri: spScopeUri, scopeUris: spScopeUris.length ? spScopeUris : undefined }
                : withBound;
            });
            // PER-USER CREDENTIALS. Copilot's `invoker` mode ran the tool under the SIGNED-IN
            // USER's own connection — Erik's mail from Erik's mailbox, Erik's CRM query
            // returning only Erik's records. Deploying that on one shared credential does not
            // fail; it silently makes every user act as one account, which is the kind of
            // wrong nobody can find by testing.
            //
            // Marked per AGENT, not per run: the same connector can be `invoker` for one agent
            // and `maker` for another, and a run-level flag would impose one agent's access
            // model on the rest.
            const invokerConnectorIds = new Set(
              (row.mapped?.ir.agentTools ?? [])
                .filter((t) => t.connectionAuthMode === 'invoker' && t.connectorId)
                .map((t) => t.connectorId!),
            );
            if (invokerConnectorIds.size) {
              scopedConnectors = scopedConnectors.map((c) =>
                invokerConnectorIds.has(c.id)
                  // The caller map rides on the connector because that is what the container
                  // sees; without it a per-user tool cannot turn "who asked" into an account
                  // in the source tenant, and refuses for everyone.
                  ? { ...applyPerUserAuth(c), callerIdentityMap }
                  : c,
              );
            }

            // Mailbox chosen per agent, applied as a per-agent secret further down.
            const surfaceMailboxes = new Map<string, string>();
            // CROSS-VENDOR SUBSTITUTION: Outlook -> Gmail, and only when the customer said so.
            //
            // Every other connector is same-vendor, so wiring it needs no decision. A mailbox
            // does: the source agent read Microsoft mail, and whether it should now read
            // Google mail is the customer's call. `resolveSurfaceTarget` returns null unless
            // an explicit 'migrate' was recorded, so an UNDECIDED agent gets no mail tools —
            // silence never reads as consent for a mailbox.
            //
            // The substitution ADDS a spec rather than replacing one: shared_office365 is
            // proxy-only and never produced a live tool, so there is nothing to replace.
            for (const msConnectorId of Object.keys(SURFACE_EQUIVALENTS)) {
              if (!usedConnectorIds.has(msConnectorId)) continue;
              const target = await resolveSurfaceTarget(appUserId, row.sourceId, msConnectorId);
              const eq = SURFACE_EQUIVALENTS[msConnectorId];
              const chosen = target && eq.targets.find((t) => t.connectorId === target.targetConnectorId);
              if (!target || !chosen) {
                result.fidelity.push({
                  component: `surface:${msConnectorId}`,
                  status: 'needs-review',
                  detail:
                    `This agent uses ${eq.sourceName} and has NO ${eq.noun} tools, because no decision ` +
                    `was recorded for it. On the connector screen choose ` +
                    `${eq.targets.map((t) => t.name).join(' or ')} — or explicitly skip ${eq.noun} — then re-run.`,
                });
                emitLog('warn', `  ${row.name}: uses ${eq.sourceName}; no decision recorded — no ${eq.noun} tools wired.`);
                continue;
              }
              // Build through the SAME builder every other connector uses, so the Gmail spec
              // gets its secret ids, auth kind and scope from the registry rather than a
              // hand-rolled copy that can drift.
              // For Teams the "keep Microsoft" target IS the source connector id, so the
              // same-vendor path has already built its spec. Adding it again would give the
              // agent two identical tool sets and a confused model. Mail never hit this
              // because shared_office365 is proxy-only and produced no spec to collide with.
              const already = scopedConnectors.some((c) => c.id === target.targetConnectorId);
              const built = already
                ? { specs: [], unsupported: [] }
                : buildLiveConnectorSpecsDetailed([target.targetConnectorId], secretIdOpts);
              // WHICH mailbox is not carried on the spec — it becomes a per-agent secret
              // further down, exactly as the Drive identity does. Recorded here and applied
              // there so both cross-vendor identities go through one mechanism.
              if (target.impersonateEmail) {
                surfaceMailboxes.set(target.targetConnectorId, target.impersonateEmail);
              }
              scopedConnectors = [...scopedConnectors, ...built.specs];
              if (!built.specs.length && !already) {
                result.fidelity.push({
                  component: `surface:${msConnectorId}`,
                  status: 'lost',
                  detail:
                    `"${chosen.name}" was chosen for this agent but its credential is not configured, ` +
                    `so no ${eq.noun} tools were wired. Add the credential and re-run.`,
                });
                emitLog('fail', `  ${row.name}: "${chosen.name}" chosen but no credential configured — no ${eq.noun} tools wired.`);
                continue;
              }
              result.fidelity.push({
                component: `surface:${msConnectorId}`,
                status: 'partial',
                detail:
                  `${eq.sourceName}: ${chosen.name}` +
                  `${target.impersonateEmail ? ` (mailbox: ${target.impersonateEmail})` : ''}. ${chosen.summary}`,
              });
              emitLog('ok', `  ${row.name}: ${eq.sourceName} -> ${chosen.name}${target.impersonateEmail ? ` (${target.impersonateEmail})` : ''}`);
            }

            // Counted per connector, because a bound operation only reaches the deployed
            // agent when its connector falls through to the generic REST builder. Claiming
            // the total made the log announce exact-argument replays that were dropped
            // moments later by the Python dispatch (see connectors/toolModule.ts).
            let boundCount = 0;
            const boundDropped: string[] = [];
            for (const [connectorId, specs] of boundBuild.byConnector) {
              const spec = scopedConnectors.find((c) => c.id === connectorId);
              if (hasDedicatedToolModule(spec?.kind ?? connectorId)) {
                boundDropped.push(`${spec?.name ?? connectorId} (${specs.length})`);
              } else {
                boundCount += specs.length;
              }
            }
            if (boundCount) {
              emitLog(
                'info',
                `    ${row.name}: ${boundCount} connector operation(s) rebuilt as exact API calls with the source agent's own arguments.`,
              );
            }
            if (boundDropped.length) {
              // Not a failure: these connectors ship purpose-built tools that cover the same
              // ground more reliably than a replayed swagger call. Said out loud anyway,
              // because "exact-argument replay" and "general-purpose tool" are different
              // promises and the report must not blur them.
              emitLog(
                'info',
                `    ${row.name}: ${boundDropped.join(', ')} use purpose-built tools rather than ` +
                  'exact-argument replays — capability is reported per operation below.',
              );

              // ...AND ACTUALLY REPORT IT, which that sentence had been promising without
              // delivering.
              //
              // findCoverage was consulted in exactly one place: the loop over
              // `readiness.blocked`. There is no loop over the BINDABLE operations, so an
              // operation that binds emits no per-operation note — and for a connector with a
              // dedicated Python module the bound spec is then DROPPED at deploy
              // (connectors/toolModule.ts). The result was silence about the operations we
              // know the most about. Measured 2026-08-20 with
              // `_diag_bindable_vs_blocked.ts`: 13 operations across Confluence (4), Jira (6)
              // and HubSpot (3) had a verified coverage row that never reached the customer,
              // including six Jira operations on 34 agents. Drive's eleven were reported only
              // because they happen to be blocked rather than bindable — an accident of the
              // captured swagger, not a design.
              for (const [connectorId, specs] of boundBuild.byConnector) {
                const spec = scopedConnectors.find((c) => c.id === connectorId);
                if (!hasDedicatedToolModule(spec?.kind ?? connectorId)) continue;
                const seen = new Set<string>();
                for (const bound of specs) {
                  if (seen.has(bound.operationId)) continue;
                  seen.add(bound.operationId);
                  const cov = findCoverage(connectorId, bound.operationId);
                  if (cov && cov.fidelity !== 'lost' && cov.tool) {
                    result.fidelity.push({
                      component: `connector:${connectorId}:${bound.operationId}`,
                      status: cov.fidelity === 'exact' ? 'mapped' : 'partial',
                      detail:
                        `"${cov.label}" (${bound.operationId}) is served by the ${cov.tool} ` +
                        `tool${cov.verified ? ', proven against a real tenant' : ''}. ` +
                        (cov.reason ? cov.reason : 'No information is lost.'),
                    });
                    continue;
                  }
                  // TWO tables, for two kinds of move, and checking only one mislabels the
                  // other's rows as unjudged. coverage.ts is same-vendor and keyed by
                  // connectorId; equivalence.ts is cross-vendor and keyed by M365Surface.
                  // SharePoint's GetAllTables lives in the second one, so a coverage-only
                  // check would have reported a proven capability as needing review.
                  const surface = surfaceForConnector(connectorId);
                  const eq = surface ? findEquivalence(surface, bound.operationId) : undefined;
                  if (eq && eq.fidelity !== 'lost' && (eq.tool || eq.graph?.tool)) {
                    const tool = eq.tool ?? eq.graph!.tool!;
                    const proven = eq.verified || eq.graph?.verified;
                    result.fidelity.push({
                      component: `connector:${connectorId}:${bound.operationId}`,
                      status: eq.fidelity === 'exact' ? 'mapped' : 'partial',
                      detail:
                        `"${eq.label}" (${bound.operationId}) is served by the ${tool} tool` +
                        `${proven ? ', proven against a real tenant' : ''}. ` +
                        (eq.reason ? eq.reason : 'No information is lost.'),
                    });
                    continue;
                  }
                  // No verdict for this operation. Say THAT, rather than nothing: an
                  // unjudged operation and a judged-and-fine one must not look identical.
                  result.fidelity.push({
                    component: `connector:${connectorId}:${bound.operationId}`,
                    status: 'needs-review',
                    detail:
                      `This agent calls "${bound.operationId}" on ${spec?.name ?? connectorId}. ` +
                      `The migrated agent has purpose-built ${spec?.name ?? connectorId} tools, ` +
                      'but nobody has confirmed which of them answers this specific operation — ' +
                      'compare a result against the original agent before relying on it.',
                  });
                }
              }
            }

            // Google Drive needs a PER-AGENT identity — the shared service-account key
            // (registry.ts) covers everyone, but WHICH person's Drive THIS agent should
            // use is never assumed (Erik's agent needs Erik's Drive, Alex's needs Alex's;
            // see db/repos/agentConnectorIdentity.ts and
            // docs/connector-architecture-decisions.md §12.5). An agent whose identity was
            // never confirmed gets NO Drive tool at all — reported as `needs-review`, never
            // silently pointed at a guess. This must run before every place below that
            // reads `scopedConnectors` (the secret-sync loop, the deploy call, and the
            // per-tool fidelity check), which is why `scopedConnectors` is reassigned in
            // place rather than left as a separate "final" variable those could miss.
            // Secret ids written straight to `dest.project` further down (currently just the
            // per-agent Drive identity, below) must never be handed to the sync loop a few
            // lines later — that loop copies FROM `session.geminiProject`, and this id never
            // lived there. Without this exclusion, every Drive-connected agent logged a
            // "Secret Manager: access version failed" 404 on its own just-written secret —
            // harmless (ensureSecretInProject no-ops on a source miss) but indistinguishable
            // from a real failure in the logs.
            const destScopedSecretIds = new Set<string>();

            // Per-agent MAILBOX for a cross-vendor surface (Outlook -> Gmail). Same mechanism
            // as the Drive identity below: the service-account key is shared across the
            // migration, but WHICH mailbox an agent reads is a per-agent fact, so it travels
            // as an agent-scoped secret rather than a migration-wide one.
            for (const [targetConnectorId, mailbox] of surfaceMailboxes) {
              const idx = scopedConnectors.findIndex((c) => c.id === targetConnectorId);
              if (idx === -1) continue;
              const agentSecretId = connectorSecretId(
                `${targetConnectorId}:agent-${row.sourceId}`,
                'impersonate_email',
                credentialScope(session),
              );
              await upsertSecretIfChanged(saToken, dest.project, agentSecretId, mailbox);
              destScopedSecretIds.add(agentSecretId);
              const entry = scopedConnectors[idx];
              scopedConnectors = scopedConnectors.map((c, i) =>
                i === idx ? { ...c, secretIds: { ...entry.secretIds, impersonate_email: agentSecretId } } : c,
              );
              emitLog('info', `    ${row.name}: ${entry.name} will act as ${mailbox}.`);
              markActsAs(result, entry.name, mailbox);
            }

            const driveIndex = scopedConnectors.findIndex((c) => c.id === 'shared_googledrive');
            if (driveIndex !== -1) {
              const identity = await getAgentConnectorIdentity(appUserId, row.sourceId, 'shared_googledrive');
              if (identity?.status === 'confirmed' && identity.impersonateEmail) {
                // Scoped by agent (sourceId), not by the whole migration — a synthetic
                // connectorId string that connectorSecretId falls through on (it is not a
                // real registry id), same trick as the deleted connectorProfileScope.
                const agentSecretId = connectorSecretId(
                  `shared_googledrive:agent-${row.sourceId}`,
                  'impersonate_email',
                  credentialScope(session),
                );
                await upsertSecretIfChanged(saToken, dest.project, agentSecretId, identity.impersonateEmail);
                destScopedSecretIds.add(agentSecretId);
                const driveEntry = scopedConnectors[driveIndex];
                scopedConnectors = scopedConnectors.map((c, i) =>
                  i === driveIndex ? { ...c, secretIds: { ...driveEntry.secretIds, impersonate_email: agentSecretId } } : c,
                );
                emitLog('info', `    ${row.name}: Google Drive will act as ${identity.impersonateEmail}.`);
                markActsAs(result, 'Google Drive', identity.impersonateEmail);
              } else {
                scopedConnectors = scopedConnectors.filter((_, i) => i !== driveIndex);
                result.fidelity.push({
                  component: 'connector:shared_googledrive:identity',
                  status: 'needs-review',
                  detail:
                    'This agent uses Google Drive, but no Google account has been confirmed for it to act as. ' +
                    'The migrated agent was deployed WITHOUT the Drive tool until an admin assigns one on the ' +
                    'Connectors screen.',
                });
                emitLog('warn', `  ${row.name}: Google Drive identity not confirmed — Drive tool NOT wired for this agent.`);
              }
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
            result.subAgents = topicSubAgents.length;
            if (topicSubAgents.length) {
              emitLog('info', `    ${row.name}: ${topicSubAgents.length} topic(s) → sub-agents in one engine.`);
            }

            // A per-environment destination (SelectMap) can point THIS agent at a
            // different Google project than the one connector credentials were saved
            // to (always session.geminiProject — see routes/migrate.ts). Without this,
            // the deploy and its per-secret IAM grant both "succeed" while the secret
            // quietly does not exist where the running agent will ever look for it —
            // confirmed live 2026-08-13 (Google Drive, 404 at inference, invisible
            // until someone actually queried the deployed agent). Best-effort and cheap
            // when already synced: no-ops once the target project already has it.
            {
              // Source is the project each credential was SAVED in, not the one currently
              // connected. Reading `session.geminiProject` here meant the copy could only
              // ever reach back to wherever the run happened to be pointing, so a credential
              // saved against a different project was never reachable at all.
              const pairs = scopedConnectors.flatMap((c) => {
                const from = credentialSourceProject.get(c.id) ?? session.geminiProject;
                if (!from) return [];
                return Object.values(c.secretIds ?? {})
                  .filter((secretId) => !destScopedSecretIds.has(secretId))
                  .map((secretId) => ({ from, secretId }));
              });
              await Promise.all(
                pairs.map(({ from, secretId }) =>
                  ensureSecretInProject(saToken, from, dest.project, secretId),
                ),
              );
            }

            // Removed 2026-08-22: guardAgainstRestrictedSharingOnAdk() used to route a
            // restricted-sharing fresh agent to low-code instead of ADK, over concern that
            // an ENABLED ADK agent's baseline reachability can't be narrowed after the fact.
            // Descoped, not disproven — live-tested 2026-08-22 that ADK's per-agent grants
            // DO correctly gate gallery/console discoverability (individual/group/org-wide
            // all matched exactly who should see the agent), which is what this tool's
            // sharing requirement actually needs. The narrower, still-unresolved question —
            // whether someone with baseline access but zero grant can reach an ADK agent via
            // a direct link bypassing the gallery — is explicitly out of scope for this
            // decision; see docs/design/PERMISSION-MAPPING-ARCHITECTURE.md §6 (2026-08-22)
            // before reintroducing a guard based on that concern. Low-code's own grant path
            // is confirmed BROKEN for the individual/group case in the meantime (Google
            // rejects setIamPolicy on a private agent — FAILED_PRECONDITION), so routing
            // restricted-sharing agents there was routing them to the path that doesn't work,
            // not the safer one.

            // GATE: will this agent's connectors actually work once deployed?
            //
            // Placed here, after the secrets have been synced into the destination project
            // and before anything is built, because this is the last moment the answer can
            // change the outcome. Deploy behaviour is frozen into the Reasoning Engine
            // pickle, so a connector that cannot authenticate at inference stays broken for
            // the life of that engine — and the failure is invisible until a customer asks
            // the agent a question and gets an apology.
            //
            // It does NOT abort the migration. A blocked connector is a real problem the
            // customer can fix (a grant, a re-entered credential) and the rest of the agent
            // — instructions, knowledge, topics — is still worth migrating. What it does is
            // make the problem impossible to miss: a warning in the run log and a
            // `needs-review` note against the agent, instead of a green `deployed=true`.
            if (scopedConnectors.length) {
              const preflightProjectNumber = await resolveProjectNumber(dest.project, saToken);
              if (preflightProjectNumber) {
                const checks = await preflightConnectors(
                  saToken,
                  dest.project,
                  preflightProjectNumber,
                  scopedConnectors.map((c) => ({
                    connectorId: c.id,
                    name: c.name ?? c.id,
                    secretIds: c.secretIds ?? {},
                  })),
                );
                for (const check of checks.filter((c) => !c.ok)) {
                  emitLog(
                    'warn',
                    `    ${row.name}: ${check.name} will NOT work once deployed - ${check.detail}`,
                  );
                  result.fidelity.push({
                    component: `connector:${check.connectorId}`,
                    status: 'needs-review',
                    detail:
                      `${check.detail} Until this is fixed the migrated agent has this tool but ` +
                      'every call to it fails, so treat the connector as unmigrated rather than working.',
                  });
                }
                const good = checks.filter((c) => c.ok).length;
                if (good) {
                  emitLog(
                    'info',
                    `    ${row.name}: ${good}/${checks.length} connector(s) passed pre-flight ` +
                      '(credentials present, readable by the deployed agent).',
                  );
                }
              }
            }

            const adk = await publishAgentToGallery(dest, saToken, row.mapped!.ir, {
              // Turn the deployer's transport-agnostic step callback into run events. The
              // deploy is 3-5 minutes of total silence otherwise, and a run that looks hung
              // is the one people kill halfway through.
              onStep: (phase, state, detail, ok) =>
                state === 'start'
                  ? emitToolStart(emit, phase, detail, `agent:${row.sourceId}`)
                  : emitToolEnd(emit, phase, ok !== false, detail, `agent:${row.sourceId}`),
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
              // Prefer what the worker really built over what the server planned. An empty
              // array from the worker is meaningful (an agent with no function tools) and is
              // NOT overwritten with the planned list — that would resurrect the false
              // expectation this replaced.
              // An EMPTY array from the worker is meaningful (an agent with no function
              // tools), so "did the worker report?" cannot be inferred from length -- it
              // needs its own flag, or the server-side fallback below silently wins.
              if (adk.toolNames) {
                adkWiredToolNames = adk.toolNames;
                workerReportedToolNames = true;
              }
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
              // Which operations actually became callable tools, per connector. An MCP
              // server is only "migrated" to the extent its declared tools rebuilt —
              // saying "mapped" because the connector is wired would claim capability we
              // did not verify per operation.
              const boundOpsByConnector = new Map<string, Set<string>>(
                [...boundBuild.byConnector].map(([id, specs]) => [id, new Set(specs.map((s) => s.operationId))]),
              );
              // The same specs by TOOL name — what the deployed agent should be able to
              // call. Verification asks the deployment for its inventory and compares.
              //
              // ONLY for connectors whose bound operations actually survive the deploy. A
              // connector with a hand-written Python module (`connector_tools/<kind>.py`)
              // gets that module's own tools and never sees `boundOperations` — so listing
              // bound names here made verification demand tools that were never going to
              // exist. Measured 2026-08-20: "Teams Coordinator" was reported as
              // "4 operations rebuilt as exact API calls", then failed verification with
              // "none of the 4 wired tool(s) are present" while its nine Teams read tools
              // were deployed and working. The agent was fine; the expectation was wrong.
              // GROUND TRUTH FIRST: the worker reports the tool names it actually wired
              // (`adk.toolNames`), and that is what verification is given a few lines below.
              // This server-side list is only the fallback for an older worker that does not
              // report them.
              //
              // Neither of the obvious server-side answers works. Listing every bound
              // operation demands tools that a hand-written Python module discards, which
              // failed a working agent (measured 2026-08-20: "none of the 4 wired tool(s) are
              // present" while nine Teams read tools were deployed and fine). Filtering those
              // out leaves the list EMPTY for such connectors, and verify.ts skips the check
              // when it is empty — a vacuous pass, which is the worse of the two errors.
              //
              // GUARDED, because it used to run unconditionally and therefore clobbered the
              // worker's real list a few lines above -- inverting the precedence this comment
              // describes. Measured live 2026-08-24 on WorkMate: the worker wired
              // `discovery_engine_search` (its grounding tool, adk_deploy.py:999), the
              // overwrite replaced the list with bound CONNECTOR names only, the agent
              // answered a knowledge question with the grounding tool exactly as designed,
              // and classifyEvidence saw zero overlap between observed and expected and
              // returned `wrong_agent_tools` -- "this deployment is serving the wrong
              // package". A healthy agent got the most alarming verdict the system has, and
              // the verdict rule was not at fault: its input was.
              if (!workerReportedToolNames) {
                adkWiredToolNames = [...boundBuild.byConnector]
                  .filter(([connectorId]) => {
                    const spec = scopedConnectors.find((c) => c.id === connectorId);
                    return !hasDedicatedToolModule(spec?.kind ?? connectorId);
                  })
                  .flatMap(([, specs]) => specs.map((sp) => sp.toolName));
              }
              // Agents in THIS run, so a connected-agent tool can say whether its target
              // is migrating alongside it (reconnect them) or is not in scope at all
              // (migrate it first). "Migrate the other agent" is useless advice when the
              // other agent is already three rows down in the same migration.
              const siblingNames = staged
                .map((s) => s.mapped?.ir.name ?? s.displayName ?? s.name ?? '')
                .filter((n) => n && n !== row.mapped!.ir.name);

              for (const tool of row.mapped!.ir.agentTools ?? []) {
                const wired = !!tool.connectorId && wiredConnectorIds.has(tool.connectorId);
                const opText = tool.operationId ? ` (${tool.operationId})` : '';

                if (tool.kind === 'mcp-server') {
                  const declared = tool.mcp?.tools ?? [];
                  const boundOps = boundOpsByConnector.get(tool.connectorId ?? '') ?? new Set<string>();
                  const rebuilt = declared.filter((op) => boundOps.has(op));
                  const missed = declared.filter((op) => !boundOps.has(op));
                  result.fidelity.push({
                    component: `tool:${tool.name}`,
                    status: rebuilt.length === 0 ? 'lost' : missed.length ? 'partial' : 'mapped',
                    detail:
                      rebuilt.length === 0
                        ? `MCP server (${tool.connectorId ?? 'unknown connector'}) was NOT migrated. Copilot reaches it through the Power Platform proxy — the agent stores no server address — and ` +
                          (declared.length
                            ? 'none of the tools it declared could be rebuilt as direct API calls.'
                            : `the source agent did not record which tools it used (${tool.mcp?.toolSelection ?? 'selection unknown'}), so there was nothing to rebuild.`)
                        : `MCP server rebuilt as ${rebuilt.length} direct ${tool.connectorId} tool(s): ${rebuilt.join(', ')}. ` +
                          'The migrated agent calls the vendor API directly instead of over MCP, so it loses MCP\'s dynamic tool discovery — it can only do what the source agent declared.' +
                          (missed.length ? ` Not rebuilt: ${missed.join(', ')}.` : ''),
                  });
                  continue;
                }

                if (tool.kind === 'connected-agent') {
                  // The tool name IS the target agent's display name in every payload
                  // measured; match on it rather than on an id the payload never carries.
                  const target = siblingNames.find(
                    (n) => n.length > 3 && tool.name.toLowerCase().includes(n.toLowerCase()),
                  );
                  result.fidelity.push({
                    component: `tool:${tool.name}`,
                    status: 'needs-review',
                    detail: target
                      ? `This agent invoked another Copilot agent, "${target}", as a tool. "${target}" IS in this migration, but Gemini agents cannot call each other, so the two arrive as independent agents — the delegation does not happen automatically and must be rebuilt (e.g. fold the other agent's instructions in, or route users to it).`
                      : `This agent invoked another Copilot agent as a tool ("${tool.name.trim()}"), and that agent is NOT part of this migration. Its behaviour is therefore absent entirely — migrate it too, then decide how the two should relate.`,
                  });
                  continue;
                }

                // `HttpRequest` is Copilot's own escape hatch — its description says it
                // "may execute any SharePoint REST API you have access to". The migrated
                // agent gets `sharepoint_list_files` / `sharepoint_read_file` instead,
                // locked to the folder the source agent named, because our app credential
                // carries Sites.Read.All and there is no per-site application permission:
                // reproducing HttpRequest faithfully would hand every user of the agent
                // read access to every site in the tenant. That is a deliberate narrowing
                // and the customer has to be told, not left to infer it from "mapped".
                if (wired && tool.operationId === 'HttpRequest') {
                  result.fidelity.push({
                    component: `tool:${tool.name}`,
                    status: 'partial',
                    detail:
                      `The source tool could call ANY ${tool.connectorId} REST endpoint. The migrated agent instead gets ` +
                      'file listing and file reading, scoped to the folder this agent was connected to. Deliberate: our app ' +
                      'credential can reach every site in the tenant, so reproducing the open-ended call would widen access ' +
                      'well beyond what the Copilot agent had. Anything the original did beyond listing and reading files is not migrated.',
                  });
                  continue;
                }

                result.fidelity.push({
                  component: `tool:${tool.name}`,
                  status: wired ? 'mapped' : 'lost',
                  detail: wired
                    ? `Connector action${opText} — a live ${tool.connectorId} tool is wired on the migrated agent.`
                    : tool.kind === 'connector'
                      ? `Connector action${opText} on ${tool.connectorId ?? 'an unknown connector'} was NOT migrated — no credentials were configured for it, or the connector has no entry in our registry. The migrated agent cannot perform this action.`
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
                // The customer reads this note, not the server log. "20 failed" with no
                // reason is unactionable; it reads as a tool defect when it is usually a
                // schema or permission problem they can fix.
                (snap.failureSamples?.length ? ` (${snap.failureSamples.slice(0, 2).join('; ')})` : '') +
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
          // A source the Confluence crawler already grounded is NOT "not migrated". Its
          // pages are in a data store attached to this agent, and the fidelity report says
          // so on the same run — leaving it in this list produced a warning that
          // contradicted the report and told the customer their knowledge was left behind
          // when it had not been (live 2026-08-12: "7 page(s) ready" and "2 knowledge
          // source(s) NOT migrated" about the same two sources, in the same run).
          const cfCrawled = preCfResult?.dataStoreId
            ? nonFile.filter((k) => Array.isArray(k.confluenceSpaceNames) && k.confluenceSpaceNames.length > 0)
            : [];
          const other = nonFile.filter(
            (k) => !dvSnapshotSources.includes(k) && !spConnectorSources.includes(k) && !cfCrawled.includes(k),
          );

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
          // ADK/Agent Engine agents are created ENABLED at registration — confirmed live
          // 2026-07-31 — reachable by anyone with baseline engine access (license +
          // agentspaceUser) via a direct query/widget call, no per-agent gate for that path.
          // Correction 2026-08-21: this reachability comes from `state: ENABLED` alone, not
          // from sharingConfig being auto-set to ALL_USERS — sharingConfig is actually unset
          // by default on ADK agents, live-confirmed by fetching a real agent's raw body
          // before/after explicitly PATCHing it (PERMISSION-MAPPING-ARCHITECTURE.md §1a).
          // grantAgentAccess()/ensureAgentAccess() below are confirmed to work on ADK agents
          // the same as low-code. Correction 2026-08-22 (§6 of that same doc): per-agent
          // grants DO correctly control gallery/console discoverability — live-tested three
          // ways (individual/group/org-wide) on a real ADK agent, each exactly matching who
          // could see it in their own "From your organization" view. What's still
          // unconfirmed is the narrower, separate question of direct-link/widget reachability
          // for someone with baseline access but zero grant — that's the scenario the
          // original comment above was based on (Email Manager Outlook), and it has not been
          // re-tested since. Don't conflate the two: "shows in the gallery" is now proven
          // grant-accurate; "can't be reached at all without a grant" is not proven either
          // way. When source chat access was narrower than org-wide, record an honest
          // over-share handoff regardless, since the direct-reachability question stays open.
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
              destinationDomains,
            });
            logIdentityResolution(row.name, resolution);
            const handoff = buildPermissionHandoff(
              row.name,
              create.agentId,
              resolution,
              perms,
              'ADK registration leaves the agent reachable by anyone with baseline access to this Gemini engine (state: ENABLED, no per-agent gate) — this is not narrowed by granting specific principals below. The grants below ensure the source-specified users/groups have explicit access; whether the agent can additionally be restricted to ONLY them is still unconfirmed for this agent type — restrict further via console Share / User permissions if needed.',
            );
            result.permissionHandoff = handoff;
            const grant = await ensureAgentAccess(
              dest,
              saToken,
              create.agentId!,
              { users: handoff.grantUsers, groups: handoff.grantGroups },
              { appUserId, tenantId: session.tenantId ?? '' },
            );
            logGrantResult(row.name, grant);
            result.fidelity.push(...permissionFidelityNotes(perms, false, handoff));
            if (grant.granted.length) {
              result.fidelity.push({
                component: 'sharing',
                status: 'mapped',
                detail: `Auto-granted chat/use access (license + engine role + roles/discoveryengine.agentUser) to: ${grant.granted.join(', ')}.`,
              });
            }
            if (grant.failed.length) {
              result.fidelity.push({
                component: 'sharing',
                status: 'needs-review',
                detail: `Could not grant access to ${grant.failed.map((f) => `${f.principal} (${f.failedAt})`).join(', ')} — grant manually via console User permissions. (${grant.failed[0]?.error})`,
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
            emitToolStart(emit, 'publish', `Publishing ${row.name}`, `agent:${row.sourceId}`);
            result.deployed = await publishAgent(dest, saToken, create.agentId);
            emitToolEnd(
              emit,
              'publish',
              result.deployed,
              result.deployed ? `Published ${row.name}` : `Publish failed for ${row.name}`,
              `agent:${row.sourceId}`,
            );
          }

          const perms = row.mapped.ir.permissions;
          const hasPerms = !!perms;
          // Backward compatible: if permissions were never extracted, keep
          // today's shareAgent(ALL_USERS) behavior.
          const orgWide = !hasPerms || isOrgWideChat(perms);
          if (orgWide || allowOvershare) {
            emitToolStart(emit, 'share', `Sharing ${row.name}`, `agent:${row.sourceId}`);
            result.shared = await shareAgent(dest, saToken, create.agentId);
            emitToolEnd(
              emit,
              'share',
              result.shared,
              result.shared ? `Shared ${row.name}` : `Share failed for ${row.name}`,
              `agent:${row.sourceId}`,
            );
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
              destinationDomains,
            });
            logIdentityResolution(row.name, resolution);
            const handoff = buildPermissionHandoff(
              row.name,
              create.agentId,
              resolution,
              perms,
              'Source chat access was not org-wide — granting license + engine role + roles/discoveryengine.agentUser to the resolved principals below instead of sharing ALL_USERS. Any unresolved/failed principals need manual console follow-up (see below).',
            );
            result.permissionHandoff = handoff;
            const grant = await ensureAgentAccess(
              dest,
              saToken,
              create.agentId!,
              { users: handoff.grantUsers, groups: handoff.grantGroups },
              { appUserId, tenantId: session.tenantId ?? '' },
            );
            logGrantResult(row.name, grant);
            result.fidelity.push(...permissionFidelityNotes(perms, false, handoff));
            if (grant.granted.length) {
              result.fidelity.push({
                component: 'sharing',
                status: 'mapped',
                detail: `Auto-granted chat/use access (license + engine role + roles/discoveryengine.agentUser) to: ${grant.granted.join(', ')}.`,
              });
            }
            if (grant.failed.length) {
              result.fidelity.push({
                component: 'sharing',
                status: 'needs-review',
                detail: `Could not grant access to ${grant.failed.map((f) => `${f.principal} (${f.failedAt})`).join(', ')} — grant manually via console User permissions. (${grant.failed[0]?.error})`,
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
        // The step that produces the evidence, and until now the longest invisible pause in
        // the run. Per-agent because the id is stable here — a step that cannot honestly
        // name its agent would be reported per phase instead.
        emitToolStart(emit, 'verify', `Verifying ${row.name} — asking it to prove its tools`, `agent:${row.sourceId}`);
        const v = await verifyAgent(dest, saToken, create.agentId, undefined, {
          reasoningEngineId: adkReasoningEngineId,
          // Only demand retrieval from agents we actually gave knowledge to.
          expectsGrounding: adkGroundedStoreCount > 0,
          // Grounding proves the DATA STORES are reachable and says nothing about the
          // connector tools. Without this an agent could deploy with every Jira tool
          // missing and still report verified.
          expectsTools: adkWiredToolNames,
        });
        result.verified = v.verified;
        result.verifyStatus = v.status;
        result.verifySample = v.sample;
        result.verifyEvidence = v.evidence;
        // The verdict, not whether the probe completed — and all THREE values of it. An
        // unknown is a check still owed: reporting it as failed blames us for a defect
        // nobody found, and reporting it as ok is the green tick an unproven agent must
        // never get. emitToolEnd carries the middle state through as outcome:'unknown'.
        emitToolEnd(
          emit,
          'verify',
          v.status === 'verified' ? true : v.status === 'failed' ? false : 'unknown',
          v.note ??
            (v.status === 'unknown'
              ? `Verification inconclusive for ${row.name} — nothing was proven either way`
              : `Verification ${v.status} for ${row.name}`),
          `agent:${row.sourceId}`,
        );
        if (v.status === 'failed' && v.note) {
          result.fidelity.push({
            component: 'verification',
            status: 'needs-review',
            detail: `The migrated agent was created but did not pass a live probe: ${v.note}.`,
          });
          emitLog('warn', `  ${row.name}: verification FAILED — ${v.note}`);
        } else if (v.status === 'unknown' && v.note) {
          // Distinct from a failure on purpose. "We could not check" used to be reported
          // as a pass, which is the most misleading thing this pipeline did: a customer
          // saw `verified` on an agent nobody had ever successfully probed.
          result.fidelity.push({
            component: 'verification',
            status: 'needs-review',
            detail: `The migrated agent was created, but we could NOT confirm it works: ${v.note}. This is not a failure — it is an unverified migration, and it needs a manual check.`,
          });
          emitLog('warn', `  ${row.name}: verification UNKNOWN — ${v.note}`);
        }
        if (v.toolsMissing?.length) {
          result.fidelity.push({
            component: 'verification:tools',
            status: 'needs-review',
            detail: `Tools wired during migration but absent from the deployed agent: ${v.toolsMissing.join(', ')}. The agent will not be able to perform those actions.`,
          });
        }
        // ── Agent memory ─────────────────────────────────────────────────────
        //
        // Copilot remembers facts about PEOPLE (Dataverse `intelligentmemory`), not about
        // agents, and it stores them as inferences a model drew. Moving them needs the
        // reasoning engine to exist (Memory Bank hangs off it) and needs the operator's
        // Microsoft→Google user mapping, so this is the first point where it is possible.
        // Only facts whose `sourceid` is this agent's botid are its own; everything else
        // is reported by the environment-level note, never attached here on a guess.
        const ownMemory = envMemory?.byAgent.get(row.sourceId.toLowerCase());
        if (ownMemory?.length && adkReasoningEngineId) {
          const mem = await migrateAgentMemory(
            ownMemory,
            memoryIdentityMap,
            {
              project: dest.project,
              location: process.env.ADK_LOCATION || 'us-central1',
              reasoningEngineId: adkReasoningEngineId,
              saToken,
            },
          );
          result.fidelity.push(...mem.notes);
          emitLog(
            mem.written === ownMemory.length ? 'ok' : 'warn',
            `  ${row.name}: ${mem.written}/${ownMemory.length} remembered fact(s) migrated into agent memory.`,
          );
        } else if (ownMemory?.length) {
          // No engine means no Memory Bank. Saying nothing here would let an agent lose
          // its entire personalization behind a clean report.
          result.fidelity.push({
            component: 'memory',
            status: 'lost',
            detail:
              `${ownMemory.length} remembered fact(s) could not be migrated: this agent was not ` +
              'deployed as a reasoning engine, and agent memory has no home without one.',
          });
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

  // Phase 1 announces its completion; Phase 2 did not, and the asymmetry is
  // actively misleading. When a run dies mid-insert — the server restarting is the
  // common way, and it happened repeatedly on 2026-08-13 — the log simply stops
  // after whichever agent finished last. Reading that tail, "Phase 2: insert 2
  // staged agent(s)" followed by one agent's result and nothing else looks exactly
  // like an agent being silently dropped by a bug. It cost a full investigation
  // before `migrationRuns.status` turned out to already say `interrupted`.
  //
  // The count is the point: `n/m` disagreeing is the signal. Stating it in the log
  // stream, where the reader already is, means an incomplete run announces itself
  // instead of having to be inferred from an absence.
  emitLog(
    results.length === staged.length ? 'info' : 'warn',
    `Phase 2 complete: ${results.length}/${staged.length} staged agent(s) processed` +
      (results.length === staged.length ? '' : ' — run ended early; re-run to continue from the insert'),
  );

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

  if (stoppedEarly) {
    // Never report a stopped run as complete. The agents that were skipped are still
    // staged, and saying "complete" about a run someone halted is the overclaim this
    // pipeline exists not to make.
    const stoppedSummary = `Stopped by request · ${summary}`;
    await finishRun(runId, stoppedSummary, 'stopped');
    emitProg(100, 'Stopped — staged agents kept, re-run to continue from the insert');
    emit({ type: 'done', summary: stoppedSummary, results });
    return;
  }

  await finishRun(runId, summary);
  emitProg(100, 'Migration complete');
  emit({ type: 'done', summary, results });
}
