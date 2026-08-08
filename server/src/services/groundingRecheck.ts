import { logger } from '../logger.js';
import { getSaToken } from '../auth/google.js';
import { verifyDocumentsIndexed, dataStoreResourcePath } from './geminiDataStore.js';
import { publishAgentToGallery } from './adkDeployer.js';
import {
  getDuePendingGroundingRechecks,
  bumpPendingGroundingRecheck,
  deletePendingGroundingRecheck,
  type PendingGroundingRecheck,
} from '../db/repos/pendingGroundingRechecks.js';
import { getAdkKnowledgeStore, upsertAdkKnowledgeStore } from '../db/repos/adkKnowledgeStores.js';
import { getAdkDeployment, recordAdkDeployment } from '../db/repos/adkDeployments.js';
import { getCachedIR } from '../db/repos/agentIR.js';
import type { GeminiDestination } from '../types.js';

// Discovery Engine indexing has been observed live to take 6-10+ minutes past
// the point import returns "done" — a single 5-minute poll budget genuinely
// isn't enough. 6 attempts at 5-minute spacing covers 30 minutes, comfortably
// past the worst case seen so far, before giving up and requiring a real
// migration re-run (which is itself self-healing — see orchestrator.ts's
// unhealthyFiles/unhealthySharePoint checks).
const MAX_ATTEMPTS = 6;
const RETRY_INTERVAL_MS = 5 * 60_000;

/**
 * Background sweep: re-verify any file grounding attempt that timed out
 * earlier without a definitive success, and — once Discovery Engine actually
 * confirms the content is indexed — automatically repoint the already-
 * deployed agent at it. This is what makes a slow-indexing file self-heal
 * within minutes instead of silently staying `lost` until a human notices
 * and re-runs the migration (or, before this existed, until someone hand-
 * writes a repair script — see the manual HR/PRD repairs on 2026-08-06 that
 * this sweep now automates).
 *
 * Best-effort: never throws — a single bad row must not stop the others or
 * crash the server (same posture as every other persistence-adjacent job in
 * this codebase).
 */
export async function runPendingGroundingRechecks(): Promise<void> {
  const due = await getDuePendingGroundingRechecks(new Date());
  if (!due.length) return;
  logger.info(`grounding recheck: ${due.length} pending file(s) due for re-verification`);
  for (const rec of due) {
    try {
      await recheckOne(rec);
    } catch (e) {
      logger.warn(`grounding recheck failed for "${rec.fileName}" (source ${rec.sourceId}): ${(e as Error).message}`);
    }
  }
}

async function recheckOne(rec: PendingGroundingRecheck): Promise<void> {
  const saToken = await getSaToken();
  const indexed = await verifyDocumentsIndexed(rec.project, saToken, rec.dataStoreId);

  if (!indexed) {
    if (rec.attempts + 1 >= MAX_ATTEMPTS) {
      logger.warn(
        `grounding recheck: "${rec.fileName}" (source ${rec.sourceId}) still not indexed after ${MAX_ATTEMPTS} attempts ` +
          `over ~${Math.round((MAX_ATTEMPTS * RETRY_INTERVAL_MS) / 60_000)} min — giving up; this needs a real migration re-run or manual review.`,
      );
      await deletePendingGroundingRecheck(rec.appUserId, rec.envUrl, rec.sourceId, rec.fileName);
      return;
    }
    await bumpPendingGroundingRecheck(rec.appUserId, rec.envUrl, rec.sourceId, rec.fileName, new Date(Date.now() + RETRY_INTERVAL_MS));
    return;
  }

  const resourcePath = dataStoreResourcePath(rec.project, rec.dataStoreId);
  await upsertAdkKnowledgeStore({
    appUserId: rec.appUserId,
    project: rec.project,
    sourceId: rec.sourceId,
    fileName: rec.fileName,
    dataStoreId: rec.dataStoreId,
    resourcePath,
    status: 'done',
  });
  logger.info(`grounding recheck: "${rec.fileName}" (source ${rec.sourceId}) is now indexed — repairing deployed agent.`);

  const dest: GeminiDestination = { project: rec.project, engine: rec.engine, assistant: rec.assistant };
  const [existing, cached] = await Promise.all([
    getAdkDeployment(rec.appUserId, rec.envUrl, rec.sourceId, dest),
    getCachedIR(rec.appUserId, rec.envUrl, rec.sourceId),
  ]);
  await deletePendingGroundingRecheck(rec.appUserId, rec.envUrl, rec.sourceId, rec.fileName);
  if (!existing || !cached) {
    logger.warn(`grounding recheck: "${rec.fileName}" indexed, but no deployment/IR record found to repair (source ${rec.sourceId}) — leave for a real re-run.`);
    return;
  }

  // Only auto-redeploy when every knowledge source on this agent is a plain
  // uploaded file — that's the only case this sweep can safely rebuild
  // groundingDataStores for from cache alone. A mixed-source agent (also has
  // SharePoint/Dataverse/website sources) needs the real orchestrator's full
  // resolution to avoid silently dropping grounding this sweep doesn't know
  // how to re-resolve — a real migration re-run already self-heals that case
  // (see orchestrator.ts's unhealthyFiles/unhealthySharePoint checks), so
  // this just logs instead of risking an incomplete repair.
  const fileSources = cached.ir.knowledgeSources.filter((k) => k.kind === 'FileUpload' && k.file?.name);
  if (fileSources.length !== cached.ir.knowledgeSources.length) {
    logger.info(
      `grounding recheck: "${rec.fileName}" indexed, but agent ${rec.sourceId} has non-file knowledge sources too — ` +
        're-run the migration for this agent to safely pick up the fix (this sweep only auto-repairs pure file-upload agents).',
    );
    return;
  }

  const groundingDataStores: { resourcePath: string; sourceName: string }[] = [];
  for (const k of fileSources) {
    const c = await getAdkKnowledgeStore(rec.appUserId, rec.sourceId, k.file!.name!, rec.project);
    if (c?.status === 'done') groundingDataStores.push({ resourcePath: c.resourcePath, sourceName: k.file!.name! });
  }
  if (!groundingDataStores.length) return; // nothing to redeploy on — shouldn't happen since we just upserted one

  const result = await publishAgentToGallery(dest, saToken, cached.ir, { groundingDataStores, existingAgentId: existing.agentId });
  if (!result.ok) {
    logger.warn(`grounding recheck: auto-repair redeploy failed for agent ${rec.sourceId}: ${result.error}`);
    return;
  }
  await recordAdkDeployment(rec.appUserId, rec.envUrl, rec.sourceId, dest, {
    reasoningEngine: result.reasoningEngine!,
    agentId: result.agentId!,
  });
  logger.info(`grounding recheck: agent ${rec.sourceId} auto-repaired — "${rec.fileName}" is now genuinely searchable, no manual step needed.`);
}
