/**
 * Knowledge-source classifier (Copilot Studio → Gemini Enterprise).
 *
 * The migration principle: **we migrate the source, not the learned index.**
 * A Copilot agent never carries Microsoft's vector store into Gemini — instead
 * each *knowledge source* is re-established on the Gemini side and re-indexed by
 * Google. This module decides, per source, *how* that re-establishment happens.
 *
 * It is deliberately PURE (no I/O): given a source's `kind` + discovered
 * references + optional uploaded-file metadata, it returns a migration strategy,
 * a retrievability verdict, the concrete Gemini target, whether the tool can do
 * it unattended, and human-readable caveats for the assessment report.
 *
 * Grounding (verified against current product docs):
 *  - Vertex AI Search / Gemini document data stores ingest TXT, JSON, MD, PDF,
 *    HTML, DOCX, PPTX, XLSX, XLSM — up to 200 MB/file, 100k files/import.
 *  - Gemini Enterprise has NATIVE federated/ingestion connectors for SharePoint
 *    Online and OneDrive — so those "reconnect" rather than copy, in theory.
 *    ⚠️ CONFIRMED BROKEN 2026-08-06 (extensive live testing, see decisions.md):
 *    both connector modes (Federated Search + OAuth 2.0 Refresh Token, and Data
 *    Ingestion + OAuth) return ZERO content — always, for hours — even with a
 *    fully healthy connector (`state: ACTIVE`), a real completed Microsoft
 *    sign-in (confirmed identity), correct delegated SharePoint API scopes
 *    (`Sites.Search.All`, `AllSites.Read`), the signed-in user having genuine
 *    personal access to the target file, and clean Microsoft-side sign-in logs
 *    (no Conditional Access block). Reproduced via raw API, a custom ADK test
 *    agent, AND the real production Assistant preview — all three agree.
 *    Workforce Identity Federation (Entra→Google identity mapping) does NOT
 *    explain this: it is documented as a per-user ACL-*trimming* layer on top
 *    of an otherwise-working connector, not a gate on whether search returns
 *    any results at all — do not spend time configuring it as a fix for empty
 *    results (the earlier version of this comment implied otherwise; that
 *    implication was never confirmed against docs and should not be trusted).
 *    Root cause is unresolved — escalated to Google Cloud Support with the
 *    full evidence trail. INTERIM WORKAROUND: for a SharePoint source that
 *    resolves to one specific, known file (has a "Knowledge URL"), use
 *    "copy mode" instead — download via Microsoft Graph app-only credentials
 *    (already granted for Dataverse extraction) and ground it exactly like a
 *    locally-uploaded file (see knowledgeDataStoreExecutor.migrateSharePointDriveItem
 *    / migrateFileToDocumentStore). This is proven working end-to-end
 *    (verified live 2026-08-06). It does NOT cover a whole-site/library
 *    reference with no single known file — that case has no fix yet.
 *  - Dataverse tables / SQL / Graph / custom APIs are queries, not indexable
 *    documents: they must be rebuilt as Gemini agent tools, never "indexed".
 */

/** How a source is re-established on the Gemini side. */
export type KnowledgeStrategy =
  | 'copy-and-index' // pull the bytes → GCS → ImportDocuments into a document data store
  | 'recreate' // recreate the pointer (e.g. a website data store over the same URL)
  | 'reconnect' // wire Gemini's native federated connector to the same source
  | 'confluence-crawler' // crawl selected Confluence spaces via REST API → GCS → ImportDocuments
  | 'dataverse-snapshot' // export a reference table's rows → a structured data store (snapshot)
  | 'rebuild-as-tool' // a live/structured source → rebuild as a Gemini agent tool/action
  | 'manual-review'; // no automatic path; a human must decide

/** Whether the source's actual content is fetchable by the tool. */
export type KnowledgeRetrievability =
  | 'bytes-in-dataverse' // author-uploaded file; content bytes fetchable from Dataverse
  | 'reference-only' // a pointer (URL / site / path); no bytes stored locally
  | 'connector-backed' // backed by a live connector/query/index; nothing stored to copy
  | 'unknown'; // could not be determined from the config — verify before promising

/** The concrete construct created on the Gemini Enterprise side. */
export type GeminiTarget =
  | 'document-data-store'
  | 'structured-data-store'
  | 'sharepoint-connector'
  | 'onedrive-connector'
  | 'gcs-import'
  | 'agent-tool'
  | 'none';

export interface KnowledgeClassification {
  strategy: KnowledgeStrategy;
  retrievability: KnowledgeRetrievability;
  geminiTarget: GeminiTarget;
  /** True only when the tool can complete this migration with NO human setup. */
  automatable: boolean;
  /** Reasons / caveats surfaced in the fidelity report (never silently dropped). */
  notes: string[];
  /**
   * The connector this source needs credentials/tools from, when it needs one.
   *
   * The classifier is the ONLY place that knows what a source actually is — every rule below
   * has already done the disambiguation (`FederatedStructuredSearchSource` means Confluence or
   * SharePoint depending on the description, and nothing downstream can redo that cheaply).
   * Stating the answer here stops consumers from re-deriving it from other fields.
   *
   * Both directions of that re-derivation shipped and both were wrong, live 2026-08-21 on one
   * agent ("Knowledge Assistant"):
   *   - `agentConnectorIds` matched /confluence/i against `notes`, and the note it hit was the
   *     one that RULES CONFLUENCE OUT ("...with no Confluence-matching description..."), so the
   *     agent was wired a live Confluence connector it never had.
   *   - the same function keyed SharePoint on `kind === 'SharePointSearchSource'`, which these
   *     federated sources are not, so five real SharePoint sources got no tool while the run
   *     logged "5 source(s) served by live tools".
   * A verdict must not be inferred from the prose explaining it.
   */
  requiresConnectorId?: string;
}

export interface ClassifierInput {
  /** The source's `kind` as read from the KnowledgeSourceConfiguration YAML. */
  kind: string;
  /** All references discovered in the config (URLs, site paths, entity names). */
  references?: string[];
  /** Present when the source is an author-uploaded file. */
  file?: { name?: string; sizeBytes?: number };
  /**
   * The source's description field from the YAML, used as a secondary signal
   * when the `kind` token is generic (e.g. FederatedStructuredSearchSource is
   * used for both Confluence and SharePoint — the description disambiguates).
   */
  description?: string;
}

// ── Gemini / Vertex AI Search ingestion limits (document data store) ──────────
export const VERTEX_SUPPORTED_FORMATS = [
  'txt', 'json', 'md', 'pdf', 'html', 'htm', 'docx', 'pptx', 'xlsx', 'xlsm',
] as const;
export const VERTEX_MAX_FILE_BYTES = 200 * 1024 * 1024; // 200 MB

export interface FileCompatibility {
  compatible: boolean;
  format?: string;
  /** Why an incompatible file can't be ingested as-is (for the report). */
  reason?: string;
}

/** The format/size gate a file must clear to be ingested by a document data store. */
export function checkFileCompatibility(
  fileName?: string,
  sizeBytes?: number,
): FileCompatibility {
  const format = fileName?.includes('.')
    ? fileName.split('.').pop()!.toLowerCase()
    : undefined;

  if (typeof sizeBytes === 'number' && sizeBytes > VERTEX_MAX_FILE_BYTES) {
    return {
      compatible: false,
      format,
      reason: `file is ${(sizeBytes / 1024 / 1024).toFixed(0)} MB — exceeds the 200 MB document-ingest limit`,
    };
  }
  if (!format) {
    return { compatible: false, reason: 'no file extension — cannot confirm a supported format' };
  }
  if (!(VERTEX_SUPPORTED_FORMATS as readonly string[]).includes(format)) {
    return {
      compatible: false,
      format,
      reason: `.${format} is not an ingestible format (supported: ${VERTEX_SUPPORTED_FORMATS.join(', ')})`,
    };
  }
  return { compatible: true, format };
}

/**
 * Table/column name hints that suggest sensitive or transactional data that
 * must NOT be flattened into a snapshot (row-level security would be lost).
 * This is a conservative first-pass heuristic on names — the real gate is a
 * human confirming the table carries no protected rows. Surfaced in the report.
 */
const SENSITIVE_HINTS = [
  'customer', 'contact', 'account', 'order', 'invoice', 'payment', 'salary',
  'employee', 'ssn', 'patient', 'lead', 'opportunity', 'email', 'phone',
  'address', 'credit', 'bank', 'user', 'person', 'transaction', 'case', 'hr',
];

/** True when a table/reference name looks like sensitive or transactional data. */
export function looksSensitive(names: string[]): boolean {
  const hay = names.join(' ').toLowerCase();
  return SENSITIVE_HINTS.some((h) => hay.includes(h));
}

/** Normalize a kind for matching: lowercase, letters only. */
function norm(kind: string): string {
  return (kind || '').toLowerCase().replace(/[^a-z]/g, '');
}

/**
 * Whether a knowledge source's raw `kind` is Copilot's public-website type
 * (`PublicSiteSearchSource`). Exported so callers outside the classifier
 * (adkDeployer.ts's needsAdkDeployment) can recognize the same source type
 * without duplicating/drifting from the RULES match below.
 */
export function isPublicWebsiteKind(kind: string): boolean {
  const k = norm(kind);
  return k.includes('publicsitesearch') || k.includes('publicwebsite');
}

interface Rule {
  /** Ordered match against the normalized kind (and optionally the full input). First match wins. */
  test: (k: string, input: ClassifierInput) => boolean;
  build: (input: ClassifierInput) => KnowledgeClassification;
}

// Rules are ORDER-SENSITIVE — the first match wins. Upload/file must precede
// SharePoint, because "upload files > SharePoint" stores bytes in Dataverse
// (a copy source), whereas a SharePoint *site* is a reference (a reconnect).
const RULES: Rule[] = [
  {
    // Author-uploaded files — bytes live in Dataverse.
    test: (k) => k.includes('fileupload') || k.includes('uploadedfile') || /(^|[^a-z])file([^a-z]|$)/.test(k) || k.includes('document'),
    build: ({ file }) => {
      const compat = checkFileCompatibility(file?.name, file?.sizeBytes);
      const notes = [
        'Author-uploaded file: bytes stored in Dataverse → copy to GCS → ImportDocuments into a document data store.',
        'Gate: verify byte retrieval at migration time AND that the format/size is ingestible (below).',
      ];
      if (file?.name) {
        notes.push(
          compat.compatible
            ? `Format check OK (.${compat.format}).`
            : `Format check FAILED: ${compat.reason} — route to manual review.`,
        );
      }
      return {
        strategy: compat.compatible === false && !!file?.name ? 'manual-review' : 'copy-and-index',
        retrievability: 'bytes-in-dataverse',
        geminiTarget: compat.compatible === false && !!file?.name ? 'none' : 'document-data-store',
        automatable: compat.compatible !== false || !file?.name,
        notes,
      };
    },
  },
  {
    // Public website search (Copilot's "PublicSiteSearchSource"). Confirmed live shape:
    //   { kind: "KnowledgeSourceConfiguration", source: { kind: "PublicSiteSearchSource", site: "<url>" } }
    // See docs/knowledge-sources-migration-playbook.md §4.1 (decision 2026-07-30,
    // re-confirmed live 2026-07-31): "You can't connect website data stores to your
    // Gemini Enterprise search and assistant apps." (Google, About apps and data
    // stores) — a PUBLIC_WEBSITE data store can be CREATED but never ATTACHED to a
    // low-code app/engine (proven via a live attach attempt, 400 FAILED_PRECONDITION).
    //
    // A genuine automatic path DOES exist via a different destination surface: ADK's
    // VertexAiSearchTool grounds a custom-deployed agent on the data store directly,
    // bypassing the attach step entirely (see adkDeployer.ts createWebsiteGroundingDataStore
    // + publishAgentToGallery). BUT that path is the opt-in, billable "publish to
    // gallery" upgrade — orchestrator.ts does not call it for the default low-code
    // migration run. So for the default path this is still `manual-review`; automatable
    // only becomes honest once a caller actually routes this source through
    // publishAgentToGallery(..., { websiteSource: source }).
    test: (k) => isPublicWebsiteKind(k),
    build: ({ references }) => ({
      strategy: 'manual-review',
      retrievability: 'reference-only',
      geminiTarget: 'none',
      automatable: false,
      notes: [
        `Public website${references?.[0] ? ` (${references[0]})` : ''}: the default (low-code) Gemini Enterprise app cannot connect website data stores (Google-documented limitation, confirmed live) — no automatic path in the default migration.`,
        'A real automated option exists via the opt-in "publish to gallery" ADK path (adkDeployer.ts) — it deploys a custom agent grounded on this exact URL via VertexAiSearchTool. Not yet wired into the default run; requires choosing that upgrade per agent.',
        'Fallback manual option: append the URL into the agent\'s instructions as plain text — NOT grounded search, just a visible mention.',
      ],
    }),
  },
  {
    // SharePoint site/library reference → Gemini native SharePoint connector.
    test: (k) => k.includes('sharepoint'),
    build: () => ({
      strategy: 'reconnect',
      retrievability: 'reference-only',
      geminiTarget: 'sharepoint-connector',
      requiresConnectorId: 'shared_sharepointonline',
      automatable: false, // confirmed broken 2026-08-06 — see module docstring
      notes: [
        'SharePoint reference: Gemini\'s native SharePoint connector (federated or ingestion) is the intended target, but is confirmed BROKEN as of 2026-08-06 — returns zero content even fully healthy/authenticated (see module docstring + decisions.md). Escalated to Google Cloud Support; not yet fixed.',
        'Interim workaround if this source resolves to one specific known file: copy mode (download via Graph, ground like an uploaded file) — proven working. No fix yet for a whole-site/library reference.',
      ],
    }),
  },
  {
    test: (k) => k.includes('onedrive'),
    build: () => ({
      strategy: 'reconnect',
      retrievability: 'reference-only',
      geminiTarget: 'onedrive-connector',
      requiresConnectorId: 'shared_onedrive',
      automatable: false,
      notes: [
        'OneDrive reference: use Gemini\'s native OneDrive federated connector against the same account/paths.',
        'NOT unattended: requires the same Workforce Identity Federation setup as SharePoint for ACL enforcement.',
      ],
    }),
  },
  {
    // Confluence spaces selected by the agent author in Copilot Studio.
    // Copilot Studio writes kind=FederatedStructuredSearchSource for Confluence knowledge
    // sources (the same generic token it uses for SharePoint federated sources). The
    // description field disambiguates: Confluence sources always contain the string
    // "Confluence items" in their description. Space names (not IDs) are stored in the
    // botcomponent name field and extracted into KnowledgeSourceIR.confluenceSpaceNames.
    // Migration: CQL search → fetch pages → GCS upload → ImportDocuments into a document
    // data store. Requires the customer's Atlassian credentials in the Connectors step.
    test: (k, input) =>
      k.includes('confluence') ||
      (k.includes('federatedstructured') &&
        (input.description ?? '').toLowerCase().includes('confluence')),
    build: ({ description }) => ({
      strategy: 'confluence-crawler',
      requiresConnectorId: 'shared_confluence',
      retrievability: 'connector-backed',
      geminiTarget: 'document-data-store',
      automatable: true,
      notes: [
        `Confluence knowledge source: the agent's selected space(s) will be crawled via Atlassian REST API (CQL search) and indexed into a Gemini document data store.`,
        description ? `Space description: "${description.slice(0, 200)}"` : 'Space names extracted from the botcomponent name field.',
        'Requires Atlassian credentials (email + API token + Confluence site URL) entered in the Connectors step.',
        'Only the exact spaces the agent author selected in Copilot Studio will be crawled — no other spaces.',
      ],
    }),
  },
  {
    // FederatedStructuredSearchSource with no Confluence-matching description.
    // Copilot Studio only reuses this generic kind for TWO known connector
    // types (see the Confluence rule immediately above) — SharePoint
    // federated search, or Confluence. The Confluence rule already claimed
    // the positive-match case (description contains "Confluence items");
    // anything else with this kind is, by elimination, the SharePoint case —
    // confirmed live 2026-08-07: a customer agent's FederatedStructuredSearchSource
    // sources (opaque skillConfiguration ids, null description) named after
    // real files ("TestingPermissions", "daily_queries.txt") that OTHER agents
    // in the same tenant reference via SharePointSearchSource with a real URL
    // for the exact same SharePoint folder — same underlying source, different
    // Copilot Studio configuration style. Flagged as an INFERENCE, not a
    // certainty, since this style carries no resolvable URL in the YAML at
    // all (only the opaque id) — unlike SharePointSearchSource/
    // SharePointKnowledgeSource, which do and hit the dedicated rule above.
    test: (k, input) => k.includes('federatedstructured') && !(input.description ?? '').toLowerCase().includes('confluence'),
    build: () => ({
      strategy: 'reconnect',
      retrievability: 'reference-only',
      geminiTarget: 'sharepoint-connector',
      requiresConnectorId: 'shared_sharepointonline',
      automatable: false,
      notes: [
        'Ambiguous "FederatedStructuredSearchSource" kind with no Confluence-matching description — Copilot Studio reuses this generic kind for SharePoint federated search or Confluence; inferred SharePoint by elimination, not confirmed.',
        'This connector-configuration style carries only an opaque skillConfiguration id, not a resolvable URL — verify the actual site/file in Copilot Studio\'s Knowledge Details screen. The automated copy-mode workaround (Graph download by URL) cannot run without one; this source needs manual URL entry or a name-based search-and-confirm step before it can be grounded automatically.',
        'Gemini\'s native SharePoint connector is confirmed BROKEN as of 2026-08-06 regardless (see the dedicated SharePoint rule above).',
      ],
    }),
  },
  {
    // Azure Blob Storage → copy bytes (needs blob credentials → not unattended).
    test: (k) => k.includes('blob') || k.includes('azurestorage'),
    build: () => ({
      strategy: 'copy-and-index',
      retrievability: 'connector-backed',
      geminiTarget: 'gcs-import',
      automatable: false,
      notes: [
        'Azure Blob: transfer objects to GCS → ImportDocuments. Feasible but needs the customer\'s blob credentials — not unattended.',
      ],
    }),
  },
  {
    // Dataverse table. Two paths, chosen by data sensitivity:
    //  - reference/catalog table  → snapshot rows into a structured data store (auto)
    //  - sensitive/transactional  → rebuild as a live tool (manual; preserves RLS)
    test: (k) => k.includes('dataverse'),
    build: ({ references }) => {
      if (looksSensitive(references ?? [])) {
        return {
          strategy: 'rebuild-as-tool',
          retrievability: 'connector-backed',
          geminiTarget: 'agent-tool',
          automatable: false,
          notes: [
            `Dataverse table "${(references ?? [])[0] ?? ''}" looks sensitive/transactional — a snapshot would flatten row-level security.`,
            'Rebuild as a live Gemini agent tool that queries the source at answer time (preserves access control and freshness).',
          ],
        };
      }
      return {
        strategy: 'dataverse-snapshot',
        retrievability: 'connector-backed',
        geminiTarget: 'structured-data-store',
        automatable: true,
        notes: [
          'Reference table: export rows to a Vertex AI Search STRUCTURED data store (Google\'s endorsed path for tabular data).',
          'SNAPSHOT — data is point-in-time and can go stale; refresh on a schedule if the table changes. For always-live data, rebuild as a tool instead.',
          'Before enabling: confirm the table carries no row-level-security-protected or PII rows (a snapshot flattens per-row access).',
        ],
      };
    },
  },
  {
    // SQL / database source → rebuild as a tool.
    test: (k) => k.includes('sql') || k.includes('database'),
    build: () => ({
      strategy: 'rebuild-as-tool',
      retrievability: 'connector-backed',
      geminiTarget: 'agent-tool',
      automatable: false,
      notes: ['SQL/database source: rebuild the connection as a Gemini agent tool; a database cannot be "indexed" as knowledge.'],
    }),
  },
  {
    // Azure AI Search / existing index → the index itself can't be moved.
    test: (k) => (k.includes('search') && (k.includes('ai') || k.includes('azure') || k.includes('cognitive'))),
    build: () => ({
      strategy: 'manual-review',
      retrievability: 'connector-backed',
      geminiTarget: 'none',
      automatable: false,
      notes: [
        'Azure AI Search index: the prebuilt index cannot be migrated. Re-point at the underlying documents (copy-and-index) or rebuild as a retrieval tool — needs a human decision.',
      ],
    }),
  },
  {
    // Microsoft Graph / enterprise connectors → need a Google-side equivalent.
    test: (k) => k.includes('graph') || k.includes('enterprise') || k.includes('connector'),
    build: () => ({
      strategy: 'rebuild-as-tool',
      retrievability: 'connector-backed',
      geminiTarget: 'agent-tool',
      automatable: false,
      notes: ['Graph/enterprise connector: no direct equivalent. Rebuild the integration against the Google-side data source and re-author as a tool.'],
    }),
  },
  {
    // Custom API / OpenAPI / MCP tool used as knowledge → rebuild as a tool.
    test: (k) => k.includes('api') || k.includes('openapi') || k.includes('mcp') || k.includes('custom') || k.includes('http'),
    build: () => ({
      strategy: 'rebuild-as-tool',
      retrievability: 'connector-backed',
      geminiTarget: 'agent-tool',
      automatable: false,
      notes: ['Custom API/tool source: recreate the tool definition, authentication, and parameters on the Gemini side.'],
    }),
  },
];

/**
 * Classify a single knowledge source into a migration strategy.
 * Unknown kinds fall through to `manual-review` with the raw kind preserved in
 * the note — never silently assumed migratable.
 */
export function classifyKnowledgeSource(input: ClassifierInput): KnowledgeClassification {
  const k = norm(input.kind);
  for (const rule of RULES) {
    if (rule.test(k, input)) return rule.build(input);
  }
  // Kind unrecognized — infer from the reference URL/path before giving up.
  // (Real Copilot agents carry Dynamics-specific kind tokens our rules don't
  // name; the reference is a reliable secondary signal.)
  const inferred = inferFromReferences(input);
  if (inferred) return inferred;

  const refs = (input.references ?? []).filter(Boolean);
  return {
    strategy: 'manual-review',
    retrievability: refs.length ? 'reference-only' : 'unknown',
    geminiTarget: 'none',
    automatable: false,
    notes: refs.length
      ? [`Unrecognized knowledge source kind "${input.kind}" (reference: ${refs.slice(0, 3).join(', ')}) — no automatic migration strategy. Raw config preserved for manual review.`]
      : [`Unrecognized knowledge source kind "${input.kind}" with no usable reference — no automatic strategy. Raw config preserved for manual review.`],
  };
}

/** Infer a strategy from the reference when the kind token is unrecognized. */
function inferFromReferences(input: ClassifierInput): KnowledgeClassification | null {
  const refs = (input.references ?? []).map((r) => r.trim()).filter(Boolean);
  const hay = refs.join(' ').toLowerCase();
  if (!hay) return null;

  if (/sharepoint\.com/.test(hay) && !/-my\.sharepoint\.com/.test(hay)) {
    return {
      strategy: 'reconnect', retrievability: 'reference-only', geminiTarget: 'sharepoint-connector', automatable: false,
      requiresConnectorId: 'shared_sharepointonline',
      notes: [
        `Kind "${input.kind}" unrecognized; inferred SharePoint from the reference URL.`,
        'Reconnect via Gemini\'s native SharePoint connector — requires identity federation for ACL enforcement.',
      ],
    };
  }
  if (/-my\.sharepoint\.com|onedrive/.test(hay)) {
    return {
      strategy: 'reconnect', retrievability: 'reference-only', geminiTarget: 'onedrive-connector', automatable: false,
      requiresConnectorId: 'shared_onedrive',
      notes: [`Kind "${input.kind}" unrecognized; inferred OneDrive from the reference URL.`, 'Reconnect via Gemini\'s native OneDrive connector — requires identity federation.'],
    };
  }
  return null;
}
