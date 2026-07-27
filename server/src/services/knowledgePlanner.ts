/**
 * Knowledge migration planner (Copilot Studio → Gemini Enterprise).
 *
 * Step 2 of knowledge migration. The classifier (step 1) decided *how* each
 * source should be re-established; this planner turns a whole agent's classified
 * sources into a concrete, executable plan:
 *   - folds all copy-and-index uploaded files into ONE document data store,
 *   - folds all website URLs into ONE website data store,
 *   - emits one action per reconnect / rebuild / manual-review source,
 *   - assigns valid Discovery Engine resource ids,
 *   - separates the automatable actions from the ones needing human setup.
 *
 * PURE (no I/O): the executor (thin Discovery Engine client) consumes this plan.
 * Keeping planning pure means it is fully testable without live credentials.
 */
import type { KnowledgeSourceIR } from '../types.js';
import type { KnowledgeStrategy, GeminiTarget } from './knowledgeClassifier.js';

export interface PlannedFile {
  sourceId: string;
  name?: string;
  format?: string;
  sizeBytes?: number;
}

export interface KnowledgeMigrationAction {
  /** Knowledge-source ids folded into this action. */
  sourceIds: string[];
  strategy: KnowledgeStrategy;
  geminiTarget: GeminiTarget;
  /** True only if the tool can execute this action with no human setup. */
  automatable: boolean;
  /** Human-facing name of the resource being created / reconnected. */
  displayName: string;
  /** Discovery Engine data store id (document/website/gcs targets only). */
  dataStoreId?: string;
  /** URLs / site paths this action operates over. */
  references?: string[];
  /** Files to copy (copy-and-index actions only). */
  files?: PlannedFile[];
  /** Ordered manual steps an operator must perform (non-automatable actions). */
  manualSteps?: string[];
  /** Website ownership verdict (owned / third-party / unknown), when applicable. */
  ownership?: string;
  /** Caveats / provenance carried from classification. */
  notes: string[];
}

export interface KnowledgeMigrationPlan {
  agentSourceId: string;
  actions: KnowledgeMigrationAction[];
  summary: {
    total: number;
    automatable: number;
    manual: number;
    byStrategy: Record<string, number>;
  };
}

/** Discovery Engine data store ids: lowercase alnum + hyphens, ≤63 chars. */
export function sanitizeDataStoreId(raw: string): string {
  const base = (raw || 'ks')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  const id = base || 'ks';
  return id.length > 63 ? id.slice(0, 63).replace(/-$/, '') : id;
}

/** Short, stable slug from the agent id for resource naming. */
function agentSlug(agentSourceId: string): string {
  return sanitizeDataStoreId(agentSourceId).slice(0, 20);
}

/**
 * Build the migration plan for one agent's knowledge sources.
 * `sources` MUST already be classified (see knowledgeClassifier). Sources with
 * no classification are treated as manual-review — never silently migrated.
 */
export function planKnowledgeMigration(
  agentSourceId: string,
  sources: KnowledgeSourceIR[],
): KnowledgeMigrationPlan {
  const slug = agentSlug(agentSourceId);
  const actions: KnowledgeMigrationAction[] = [];

  const uploads = sources.filter((s) => s.classification?.strategy === 'copy-and-index' && s.classification?.geminiTarget === 'document-data-store');
  const websites = sources.filter((s) => s.classification?.strategy === 'recreate' && s.classification?.geminiTarget === 'website-data-store');
  const grouped = new Set([...uploads, ...websites].map((s) => s.id));

  // 1. All ingestible uploaded files → ONE document data store for the agent.
  if (uploads.length) {
    actions.push({
      sourceIds: uploads.map((s) => s.id),
      strategy: 'copy-and-index',
      geminiTarget: 'document-data-store',
      automatable: true,
      displayName: `Documents (${uploads.length} file${uploads.length > 1 ? 's' : ''})`,
      dataStoreId: sanitizeDataStoreId(`${slug}-docs`),
      files: uploads.map((s) => ({
        sourceId: s.id,
        name: s.file?.name,
        format: s.file?.format,
        sizeBytes: s.file?.sizeBytes,
      })),
      notes: [
        'Copy bytes from Dataverse → GCS → ImportDocuments into this data store.',
        'Verify byte retrieval per file at run time; reconcile indexed count from the import operation result, not the upload count.',
      ],
    });
  }

  // 2. All website sources → ONE website data store (URLs merged).
  if (websites.length) {
    const urls = dedupe(websites.flatMap((s) => s.references ?? (s.reference ? [s.reference] : [])));
    actions.push({
      sourceIds: websites.map((s) => s.id),
      strategy: 'recreate',
      geminiTarget: 'website-data-store',
      // Honors classification: website auto-create is possible but indexing
      // needs domain verification, so it is NOT unattended.
      automatable: urls.length > 0 && websites.some((s) => s.classification?.automatable),
      displayName: `Website (${urls.length} URL${urls.length > 1 ? 's' : ''})`,
      dataStoreId: sanitizeDataStoreId(`${slug}-web`),
      ownership: websites[0]?.classification?.ownership,
      references: urls,
      manualSteps: urls.length ? undefined : ['No URL captured in the source config — supply the target URL before creating the website data store.'],
      notes: ['Recreate as a website data store; Gemini re-crawls the URL(s).'],
    });
  }

  // 3. Everything else → one action per source (snapshot / reconnect / rebuild / manual).
  for (const s of sources) {
    if (grouped.has(s.id)) continue;
    const c = s.classification;
    const strategy = c?.strategy ?? 'manual-review';
    // A Dataverse snapshot gets its own structured data store, one per table.
    const dataStoreId =
      strategy === 'dataverse-snapshot' ? sanitizeDataStoreId(`${slug}-tbl-${s.name || s.reference || 'table'}`) : undefined;
    actions.push({
      sourceIds: [s.id],
      strategy,
      geminiTarget: c?.geminiTarget ?? 'none',
      automatable: Boolean(c?.automatable),
      displayName: s.name || s.kind,
      dataStoreId,
      references: s.references?.length ? s.references : s.reference ? [s.reference] : undefined,
      manualSteps: manualStepsFor(strategy, s),
      notes: c?.notes ?? [`Unrecognized source "${s.kind}" — manual review.`],
    });
  }

  const byStrategy: Record<string, number> = {};
  for (const a of actions) byStrategy[a.strategy] = (byStrategy[a.strategy] ?? 0) + 1;

  return {
    agentSourceId,
    actions,
    summary: {
      total: actions.length,
      automatable: actions.filter((a) => a.automatable).length,
      manual: actions.filter((a) => !a.automatable).length,
      byStrategy,
    },
  };
}

/** Concrete operator checklist for the non-automatable strategies. */
function manualStepsFor(strategy: KnowledgeStrategy, s: KnowledgeSourceIR): string[] | undefined {
  const ref = s.references?.[0] ?? s.reference;
  switch (strategy) {
    case 'reconnect':
      return [
        `Create a Gemini native ${s.classification?.geminiTarget === 'onedrive-connector' ? 'OneDrive' : 'SharePoint'} federated connector against ${ref ?? 'the same source'}.`,
        'Configure Workforce Identity Federation (Entra→Google) so document ACLs are enforced — without it, access is not trimmed.',
        'Validate a permission-trimmed query before cutover.',
      ];
    case 'rebuild-as-tool':
      return [
        `Recreate ${s.kind} as a Gemini agent tool/action (${ref ?? 'source connection'}).`,
        'Reauthor authentication, parameters, and input/output schema on the Google side.',
      ];
    case 'copy-and-index':
      // Reaches here only for non-document targets (e.g. Azure Blob w/ creds).
      return ['Provide source credentials, transfer objects to GCS, then ImportDocuments.'];
    case 'manual-review':
      return ['No automatic path — a human must decide how (or whether) to migrate this source. Raw config preserved.'];
    default:
      return undefined;
  }
}

function dedupe(arr: string[]): string[] {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}
