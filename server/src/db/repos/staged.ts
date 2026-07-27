import { config } from '../../config.js';
import { logger } from '../../logger.js';
import { getDb, isDbConnected } from '../core.js';
import type { FidelityNote, MappedAgent } from '../../types.js';
import type { KnowledgeStrategy, KnowledgeRetrievability, GeminiTarget } from '../../services/knowledgeClassifier.js';

/** Flat, queryable per-source knowledge summary stored on the staged row. */
export interface StagedKnowledge {
  id: string;
  name: string;
  kind: string;
  /** URL / site / entity reference (primary), for direct querying. */
  reference?: string;
  /** Author's description of the source ("...answer questions about D365..."). */
  description?: string;
  strategy: KnowledgeStrategy;
  geminiTarget: GeminiTarget;
  retrievability: KnowledgeRetrievability;
  automatable: boolean;
  /** Present for uploaded files: the format/size ingest-gate verdict. */
  fileFormat?: string;
  fileCompatible?: boolean;
  // ── provenance metadata (audit trail) ──
  componentType?: number;
  createdOn?: string;
  modifiedOn?: string;
  isManaged?: boolean;
  status?: string;
}

/**
 * Flat, queryable per-capability summary stored on the staged row (the topics
 * plan's business capabilities). Lossless plan lives on `mapped.ir` + the cached
 * IR; this is the flat copy you can query straight from the DB.
 */
export interface StagedCapability {
  id: string; // source topic id (provenance)
  name: string;
  domain: string;
  classification: string; // system|qa|transactional|orchestration
  fidelity: string; // full|high|partial
  determinism: string; // soft|requires-deterministic
  triggers: string[];
  toolCount: number;
  usesKnowledge: boolean;
  stateIn: string[]; // input variables the capability needs
  stateOut: string[]; // variables it produces
  unresolvedState: string[]; // read-but-never-set variables (needs review)
  needsHumanReview: boolean;
  nodeCount: number;
}

/**
 * Staging area for the fetch-then-migrate pipeline (collection: stagedAgents).
 * Phase 1 (extract) writes one row per agent with status `staged`; phase 2
 * (insert) reads `staged` rows, creates them in Gemini, and flips each to
 * `inserted` or `failed`. This is the DB-backed decoupling between extract and
 * insert — the same pattern GEM_CO uses for conversations.
 */

const COLL = 'stagedAgents';

export type StageStatus = 'staged' | 'inserted' | 'failed' | 'skipped';

export interface StagedAgent {
  runId: string;
  appUserId: string;
  envUrl: string;
  envName: string;
  sourceId: string;
  name: string;
  displayName: string;
  status: StageStatus;
  mapped?: MappedAgent; // includes .ir — everything the insert phase needs
  fidelity: FidelityNote[];
  // ── Explicit, queryable copies of the key content (stored in detail so you
  //    can read source vs. target text straight from the DB) ──
  sourceInstructions?: string; // authored Copilot Studio instructions (raw)
  sourceDescription?: string; // extracted source description
  targetInstruction?: string; // synthesized Gemini instruction (what we insert)
  targetDescription?: string; // Gemini description (what we insert)
  topicCount?: number;
  thinContent?: boolean; // prebuilt/AI-Builder agent with little to extract
  // ── source agent provenance (Copilot "Agents" list columns; report/audit) ──
  sourceType?: string; // "Agent"
  sourceOwnerId?: string;
  sourceCreatedOn?: string;
  sourceModifiedOn?: string; // Copilot "Last modified"
  sourceProtected?: boolean; // Copilot "Protection status: Protected"
  sourceManaged?: boolean;
  sourceStatus?: string;
  // ── knowledge sources (classified during extraction) ──
  knowledgeCount?: number;
  knowledgeAutoMigratable?: number; // sources the tool can migrate unattended
  knowledgeManual?: number; // sources needing manual setup/review
  knowledge?: StagedKnowledge[]; // flat, queryable per-source classification
  // ── topics (compiled into capabilities during extraction) ──
  topicCapabilities?: StagedCapability[]; // flat, queryable per-capability
  topicsSummary?: {
    capabilities: number;
    connectedAgents: number;
    fullFidelity: number;
    partialFidelity: number;
    needsReview: number;
    deterministicTools: number;
    unresolvedInputs: number;
  };
  geminiAgentId?: string;
  deployed?: boolean;
  shared?: boolean;
  verified?: boolean;
  verifySample?: string;
  error?: string;
  stagedAt?: Date;
  insertedAt?: Date;
}

/** Upsert a staged (extracted + mapped) agent. Called during phase 1. */
export async function stageAgent(row: StagedAgent): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { runId: row.runId, sourceId: row.sourceId },
      { $set: { ...row, stagedAt: new Date() } },
      { upsert: true },
    );
  } catch (e) {
    logger.warn(`stageAgent persist failed: ${(e as Error).message}`);
  }
}

/** Read staged rows for a run, optionally filtered by status. Phase 2 reads these. */
export async function listStaged(runId: string, status?: StageStatus): Promise<StagedAgent[]> {
  if (!isDbConnected()) return [];
  try {
    const filter: Record<string, unknown> = { runId };
    if (status) filter.status = status;
    return await getDb(config.CSGE_DB).collection<StagedAgent>(COLL).find(filter).toArray();
  } catch (e) {
    logger.warn(`listStaged read failed: ${(e as Error).message}`);
    return [];
  }
}

/** Update a staged row's status/result after an insert attempt. */
export async function markStaged(
  runId: string,
  sourceId: string,
  patch: Partial<StagedAgent>,
): Promise<void> {
  if (!isDbConnected()) return;
  try {
    await getDb(config.CSGE_DB).collection(COLL).updateOne(
      { runId, sourceId },
      { $set: { ...patch, insertedAt: new Date() } },
    );
  } catch (e) {
    logger.warn(`markStaged persist failed: ${(e as Error).message}`);
  }
}
