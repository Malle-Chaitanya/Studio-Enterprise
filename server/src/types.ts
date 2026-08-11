import type { TopicGraph } from './services/topicGraph.js';
import type { KnowledgeClassification } from './services/knowledgeClassifier.js';

/**
 * Types shared across the migration pipeline.
 *
 * The AgentIR (Intermediate Representation) is the heart of the tool: a
 * platform-neutral, normalized description of a Copilot Studio agent that the
 * mapper turns into a Gemini Enterprise agent. Extraction fidelity lives here —
 * everything the target could possibly need is captured, even if v1 doesn't map
 * all of it yet (unmapped fields still surface in the fidelity report).
 */

/** Copilot Studio botcomponent.ComponentType values we care about. */
export const ComponentType = {
  Topic: 9,
  Dialog: 10,
  BotFileAttachment: 14, // uploaded knowledge files — bytes in the `filedata` File column
  CustomGpt: 15, // GptComponentMetadata — holds the real agent instructions
  KnowledgeSource: 16,
} as const;

export interface TopicIR {
  id: string;
  name: string;
  /** Raw AdaptiveDialog YAML from botcomponent.data. */
  raw: string;
  /** Trigger phrases / utterances that activate this topic. */
  triggerPhrases: string[];
  /**
   * The topic's authored `modelDescription` — a plain-English description of
   * what the topic/tool does. This is the most reliable human-readable content
   * on a topic (present on generative-agent topics), so we prefer it for
   * summaries and capability lines over raw message bindings.
   */
  modelDescription?: string;
  /** Human-readable summary of what the topic does (best-effort from the YAML). */
  summary: string;
  /** Message activities the topic sends back to the user. */
  messages: string[];
  /** Whether the topic invokes an AI Builder model (needs Gemini reasoning). */
  usesAiBuilder: boolean;
  /** The AI Builder model name this topic invokes, when resolved. */
  aiModelName?: string;
  /**
   * The AI Builder model's real prompt text, resolved from
   * msdyn_aiconfigurations. For prebuilt Dynamics agents this is the actual
   * "brain" — without it the migrated agent is an empty shell.
   */
  aiPrompt?: string;
  /** Whether the topic outputs Adaptive Cards (needs conversion). */
  usesAdaptiveCards: boolean;
  /** System topics (Fallback, Escalate, etc.) vs. custom author topics. */
  isSystem: boolean;
  /** Structured behavior graph (AgentIR v2 §4) — the real conversation logic. */
  graph?: TopicGraph;
}

export interface KnowledgeSourceIR {
  id: string;
  name: string;
  /** e.g. PublicSiteSearch, SharePoint, DataverseQnA, FileUpload. */
  kind: string;
  /** URL / site / entity reference, when present (primary; kept for back-compat). */
  reference?: string;
  /** All references discovered in the config (URLs, site paths, entity names). */
  references?: string[];
  /** Author's description of what the source is for (folded into instruction). */
  description?: string;
  /**
   * Primary Confluence signal: space display names parsed from the Dataverse `description`
   * column ("…Confluence items: Engineering, Chaitanya Malle, Demo Company Wiki").
   * Comma-separated; most reliable for CQL queries. Cross-reference with the signals
   * below if this is absent or the description format changes.
   * Space IDs are NOT stored in Dataverse — only display names are available.
   */
  confluenceSpaceNames?: string[];
  /**
   * Auto-generated `source.skillConfiguration` from the YAML data blob — a stable,
   * system-written identifier. Format: "{spacesConcatenated}_{randomSuffix}".
   * e.g. "Engineering_ChaitanyaMalleDemoCompanyWiki_0ioUg9wnrKb1GTC6avSgS".
   * Word boundaries between space names are lost (no separators), so this cannot
   * be split back into individual names reliably — use as a stable key / fallback.
   */
  confluenceSkillConfig?: string;
  /**
   * Botcomponent `name` field — comma-separated space names when the author did not
   * customize the label (e.g. "Engineering, Chaitanya Malle, Demo Company Wiki").
   * UNRELIABLE: the author can set this to any string; always prefer `confluenceSpaceNames`.
   */
  confluenceComponentName?: string;
  /**
   * Concatenated space-name key from the botcomponent `schemaname`, with the dotted
   * type prefix and random suffix stripped.
   * e.g. "crf37_Agent.topic.SpaceASpaceB_QfXX…" → "SpaceASpaceB".
   * Same concatenation as `confluenceSkillConfig` prefix — useful for cross-referencing.
   */
  confluenceSchemaName?: string;
  /** Present when the source is an author-uploaded file. */
  file?: {
    name?: string;
    format?: string;
    sizeBytes?: number;
    /** Whether the file clears Gemini's document-ingest format/size gate. */
    compatible?: boolean;
    incompatReason?: string;
  };
  /**
   * Migration strategy for this source (added in the knowledge phase). See
   * `services/knowledgeClassifier.ts`. Optional so pre-classifier IRs stay valid.
   */
  classification?: KnowledgeClassification;
  /** Source-side provenance metadata (audit trail; not migrated, preserved). */
  metadata?: KnowledgeSourceMetadata;
  /** Parsed KnowledgeSourceConfiguration, preserved losslessly for manual review. */
  raw?: unknown;
}

/** Provenance metadata for a knowledge source, read from Dataverse. */
export interface KnowledgeSourceMetadata {
  /** botcomponent.componenttype (14 = file attachment, 16 = knowledge source). */
  componentType?: number;
  createdOn?: string; // ISO
  modifiedOn?: string; // ISO
  /** Whether the component is part of a managed solution. */
  isManaged?: boolean;
  /** Human-readable status ('active' | 'inactive'), from statuscode. */
  status?: string;
  /** Raw systemuser id who last modified this component (unresolved — see
   *  services/dataverse.ts resolveSystemUserEmail). Used to scope a
   *  SharePoint/OneDrive search to the person who added the source. */
  modifiedByUserId?: string;
}

/**
 * Agent-level SOURCE metadata (provenance). Preserved for the migration
 * report / audit trail. Mirrors the Copilot "Agents" list columns: Type,
 * Owner, Last modified, Protection status, etc. Most fields here are NOT
 * migrated into Gemini, which has its own lifecycle metadata
 * (createTime/updateTime/state) — the one exception is `lastPublished`,
 * which the orchestrator reads to decide whether to publish the migrated
 * Gemini agent (see orchestrator.ts insert phase): a source agent that was
 * never published in Copilot Studio (Draft) stays a Draft in Gemini too,
 * instead of every migrated agent being force-published.
 */
export interface AgentSourceMetadata {
  type?: string; // e.g. "Agent"
  ownerId?: string; // systemuser/team id (name needs an expand — best-effort)
  createdOn?: string; // ISO
  modifiedOn?: string; // ISO  → Copilot "Last modified"
  /** ISO, or undefined if the source agent was never published (still Draft). Drives publish gating — see interface doc. */
  lastPublished?: string;
  isManaged?: boolean; // part of a managed solution
  protected?: boolean; // Copilot "Protection status: Protected" (≈ managed)
  status?: string; // 'active' | 'inactive'
  schemaName?: string;
}

/** A security principal on either side of the migration (platform-neutral). */
export interface PrincipalRef {
  type: 'user' | 'team' | 'group';
  /** Source id: Dataverse systemuserid / teamid, or Entra group objectId. */
  id: string;
  /** Primary email / UPN when resolvable — the join key for identity mapping. */
  email?: string;
  displayName?: string;
}

/** A principal granted explicit rights on the source agent (a share). */
export interface SharedPrincipal extends PrincipalRef {
  /**
   * Dataverse AccessRights, decoded into stable tokens
   * (Read | Write | Append | AppendTo | Share | Assign | Delete).
   */
  rights: string[];
  /** Coarse roll-up for mapper/report: coauthor ≈ edit, viewer ≈ Read only. */
  roleHint?: 'coauthor' | 'viewer' | 'custom';
  /**
   * Best-effort Copilot Studio Share-dialog semantics (live-validated 2026-08):
   * - editor — Studio "Editor access" (view/edit/configure/share/publish; not delete)
   * - agent-viewer — Studio "Agent viewer" (Analytics/Evaluation). Often **blocked** when
   *   the user already has Environment Maker (typical licensed maker).
   * - end-user — Studio "End user access" (chat/connections only; does NOT appear in
   *   the maker Agents list). Usually surfaces via chatAccess, not this record share.
   */
  studioShareRole?: 'editor' | 'agent-viewer' | 'end-user' | 'unknown';
}

/**
 * End-user CHAT access — separate from record sharing. Maps to Gemini sharing
 * intent (org-wide vs narrower).
 */
export interface ChatAccess {
  policy: 'any' | 'copilot-readers' | 'group' | 'any-multitenant' | 'unknown';
  policyCode?: number;
  /** Up to 20 Entra security group objectIds when policy = 'group'. */
  groupIds: string[];
}

/**
 * Source access model for an agent. Additive & optional — absent on IRs
 * extracted before this feature, or when shares could not be read.
 */
export interface AgentPermissions {
  owner?: PrincipalRef;
  sharedPrincipals: SharedPrincipal[];
  chatAccess?: ChatAccess;
  /**
   * Set when we could read the bot row but NOT its shares (insufficient
   * privilege). Never treat empty sharedPrincipals as "no one has access".
   */
  readError?: string;
}

/** Customer override map: Microsoft principal → Google Workspace principal. */
export interface IdentityMapOverrides {
  /** sourceEmail/UPN (lowercased) → googleEmail */
  users: Record<string, string>;
  /** sourceGroupObjectId → googleGroupEmail */
  groups: Record<string, string>;
}

export interface ResolvedPrincipal {
  source: PrincipalRef;
  google?: { type: 'user' | 'group'; email: string };
  via: 'override' | 'email-match' | 'email-match-unverified' | 'group-match' | 'unmatched';
  reason?: string;
}

export interface PermissionResolution {
  owner: ResolvedPrincipal | undefined;
  /** Studio Editor / Dataverse coauthor shares. */
  coauthors: ResolvedPrincipal[];
  /** Studio Agent viewer / read-only shares (often Environment Maker–incompatible on source). */
  viewers: ResolvedPrincipal[];
  /** Chat-scoped groups / end-user chat principals. */
  chatPrincipals: ResolvedPrincipal[];
  unmatched: ResolvedPrincipal[];
}

/**
 * Manual permission handoff when Gemini cannot apply per-user/group sharing
 * via API (only ALL_USERS is supported today).
 */
export interface PermissionHandoff {
  agentName: string;
  geminiAgentId?: string;
  reason: string;
  /** All mapped Google user emails (union) — backward-compatible checklist. */
  grantUsers: string[];
  grantGroups: string[];
  /**
   * Categorized for honest enterprise reporting (Studio → Gemini ceiling):
   * chatUsers = need use/chat access; editorUsers = had Studio Editor (no Gemini
   * per-agent co-admin); viewerUsers = had Agent viewer (no Gemini equivalent).
   */
  chatUsers?: string[];
  editorUsers?: string[];
  viewerUsers?: string[];
  unresolved: { source: string; reason: string }[];
  steps: string[];
}

export interface AgentIR {
  /** Copilot Studio botid. */
  sourceId: string;
  name: string;
  /** The real agent instructions from GptComponentMetadata.instructions. */
  instructions: string;
  description: string;
  /** Whether the source agent had web browsing / code interpreter enabled. */
  capabilities: { webBrowsing: boolean; codeInterpreter: boolean };
  starterPrompts: string[];
  topics: TopicIR[];
  knowledgeSources: KnowledgeSourceIR[];
  /** Dataverse schema name (e.g. msdyn_SalesStakeholderAgent). */
  schemaName?: string;
  /**
   * True when this is a Microsoft-managed/prebuilt agent (ismanaged) whose real
   * behavior may live in a managed GPT template or AI Builder model rather than
   * authored, extractable text. Used to set an honest fidelity note.
   */
  isManaged?: boolean;
  /**
   * True when the agent has no authored instructions AND its only logic is
   * AI Builder / external — i.e. there is very little extractable content.
   */
  thinContent?: boolean;
  /** Fields extracted but not yet mapped in v1 (surfaced in the report). */
  unmapped: string[];
  /** Agent-level source provenance (report/audit only; not migrated to Gemini). */
  sourceMetadata?: AgentSourceMetadata;
  /** Source access model (owner, shares, chat access). Optional/additive. */
  permissions?: AgentPermissions;
  /**
   * Tools the agent can invoke — connector operations, MCP servers, connected
   * agents and AI Builder models (Dataverse componenttype 9, `kind: TaskDialog`).
   *
   * Extraction previously read only CustomGpt / Topic / KnowledgeSource /
   * BotFileAttachment, so an agent wired to five Jira operations produced an IR
   * that mentioned none of them (live 2026-08-07, "Enterprise Migration
   * Knowledge"). The connector SCAN saw them, but the IR the migration maps from
   * did not — so the operations could never reach the target agent, and the
   * report could not say what was lost.
   *
   * Optional and additive: an agent with no tools simply omits it.
   */
  agentTools?: AgentToolIR[];
}

/** How a tool is invoked in Copilot Studio. Mirrors `action.kind`. */
export type AgentToolKind =
  /** A Power Platform connector operation, e.g. Jira `ListIssues`. */
  | 'connector'
  /** A remote MCP server exposed as a tool (`InvokeExternalAgentTaskAction`). */
  | 'mcp-server'
  /** Another Copilot agent invoked as a tool. */
  | 'connected-agent'
  /** An AI Builder prompt/model. */
  | 'ai-builder'
  /** A TaskDialog whose action kind we do not recognise — preserved, never dropped. */
  | 'unknown';

/**
 * One invocable tool on the source agent.
 *
 * `connectorId` + `operationId` together are what make a tool reproducible: knowing
 * an agent "uses Jira" is not enough to rebuild it, because Jira exposes dozens of
 * operations and this agent chose five specific ones.
 */
export interface AgentToolIR {
  /** Component name as authored, e.g. "Jira - Get list of issues". */
  name: string;
  kind: AgentToolKind;
  /** Model-facing display name (`modelDisplayName`), when present. */
  displayName?: string;
  /** Model-facing description (`modelDescription`) — what the tool is for. */
  description?: string;
  /** Registry connector id parsed from the connection reference, e.g. `shared_jira`. */
  connectorId?: string;
  /**
   * Whose credentials the action runs under, from `connectionProperties.mode`.
   *
   * `invoker` — the signed-in END USER's own connection, so each person sees only what
   * they already have access to. `maker` — one shared connection the author configured,
   * the same for everyone. `undefined` — the payload did not say.
   *
   * Load-bearing for access fidelity: migrating an `invoker` tool onto our app-only
   * service credential gives every end user the service account's entire view. That must
   * be reported, and where possible replaced with a Gemini Enterprise end-user
   * authorization, rather than shipped silently.
   */
  connectionAuthMode?: 'invoker' | 'maker';
  /** The exact operation invoked, e.g. `ListIssues`, `GetIssue_V2`. */
  operationId?: string;
  /** Declared output property names, when the component lists them. */
  outputs?: string[];
  /** Dataverse schema name of the component. */
  schemaName?: string;
}

/**
 * Discovered facts about the customer organization — the single source of truth
 * later phases (classification, planning, reporting) read from, instead of
 * re-deriving from an admin email. Built once from both clouds, best-effort:
 * missing scopes degrade a field, never fail the whole profile.
 */
export interface OrganizationProfile {
  discoveredAt: string; // ISO
  microsoft: {
    tenantId?: string;
    adminEmail?: string;
    /** All verified domains for the tenant (Graph organization.verifiedDomains). */
    verifiedDomains: string[];
    environments: { name: string; url: string; id: string }[];
  };
  google: {
    adminEmail?: string;
    project?: string;
    /** Verified Workspace domains (Directory API, when the SA has the scope). */
    workspaceDomains: string[];
    /** Real Workspace user emails (Directory API, when the SA has the scope) —
     *  lets identity resolution verify a same-email match actually EXISTS,
     *  not just that its domain is owned by the org. Empty when the Directory
     *  read is unavailable; callers must not treat empty as "no users exist,"
     *  only as "existence can't be verified" (falls back to domain-only). */
    verifiedUserEmails: string[];
  };
  /** Unified, deduped set of every domain the org owns (both clouds). */
  ownedDomains: string[];
  /** Which discovery sources actually contributed (for transparency in the UI). */
  domainSources: string[];
}

/** A reference to a source agent (matches Dataverse BotSummary structurally). */
export interface AgentRef {
  botid: string;
  name: string;
}

/**
 * Migration scope — the flexible boundary the whole tool is built around.
 * The pipeline below the scope is scope-agnostic: resolveScope() expands any
 * scope into a flat work-list the orchestrator runs unchanged.
 */
export type MigrationScope =
  | { kind: 'agents'; env: string; botIds: string[] } // one or many agents in an env
  | { kind: 'environments'; envs: string[] } // one, many, or all selected environments
  | { kind: 'tenant' } // every accessible environment
  | { kind: 'selection'; units: { env: string; botIds: string[] }[] }; // exact per-env agent picks

/**
 * A concrete Gemini Enterprise destination — the resource coordinates an agent
 * is created under. This is the internal resolution of a customer's logical
 * "environment"; the customer never sees these field names.
 *   project   — Google Cloud project number/id (e.g. "860501065102")
 *   engine    — Agentspace engine/app id (e.g. "agentspace-engine")
 *   assistant — assistant id under the engine (default "default_assistant")
 */
export interface GeminiDestination {
  project: string;
  engine: string;
  assistant: string;
  /**
   * Optional, customer-declared Gemini Enterprise edition for this
   * destination. Currently unread by the orchestrator (see
   * .claude/memory/decisions.md, 2026-08-05 — ADK is now always tried
   * first, low-code only as a last-resort fallback, since no edition's
   * low-code agent auto-lists via the API, per
   * docs/GEMINI-EDITIONS-AND-AGENT-VISIBILITY.md). Left here for reporting/
   * future use; not a behavioral switch today. NOT auto-detected — no
   * reliable API signal for edition was found.
   */
  edition?: 'business' | 'standard' | 'plus';
}

/** Destination-mapping options (how source environments map into Gemini). */
export interface DestinationOptions {
  /**
   * Per-source-environment target (env url → Gemini destination). This is the
   * real routing map: each Copilot environment's agents are created under its
   * mapped engine. V1 maps to EXISTING engines only (no auto-create).
   */
  environmentMap?: Record<string, GeminiDestination>;
  /** @deprecated legacy name-prefix map (env url → label). Superseded by environmentMap. */
  projects?: Record<string, string>;
  /**
   * When true, narrower-than-org-wide source chat access is still shared
   * ALL_USERS (over-share). Default false — emit PermissionHandoff instead.
   */
  allowOvershare?: boolean;
}

/** One environment's worth of resolved work. */
export interface ScopeUnit {
  envUrl: string;
  envName: string;
  bots: AgentRef[];
}

/** A fully resolved plan the orchestrator can execute. */
export interface ResolvedPlan {
  units: ScopeUnit[];
  totalAgents: number;
  destination: DestinationOptions;
  /** Dry run: extract + map + assess, but do NOT create/deploy/share in Gemini. */
  dryRun?: boolean;
  /** Third-party connector IDs whose credentials have been saved to Secret Manager. */
  savedConnectors?: string[];
  /** Whether MS native app registration creds were saved (Teams/SharePoint/Office365). */
  msCreds?: boolean;
  /**
   * Redeploy even when nothing about the SOURCE agent changed.
   *
   * Drift detection compares the Copilot agent against the last migration, so an agent
   * whose source is untouched is skipped as "already exists". That is right for the
   * source, and wrong for everything else: when the DEPLOYMENT changes — a fixed tool
   * name, a new connector wiring, a corrected instruction — there is otherwise no way
   * to get the change onto an already-migrated agent short of editing the Copilot agent
   * to fake a difference (hit repeatedly on 2026-08-07).
   *
   * Creates a new Reasoning Engine; the previous one is not deleted automatically.
   */
  forceRedeploy?: boolean;
}

/** Result of mapping one AgentIR to a Gemini agent definition. */
export interface MappedAgent {
  ir: AgentIR;
  displayName: string;
  description: string;
  instruction: string;
  starterPrompts: { text: string }[];
  model: string;
  tools: { name: string }[];
  /**
   * Full Discovery Engine data store resource paths to ground this agent on.
   * When set, the low-code agent uses dataStoreSpecs (native grounding) instead
   * of selectedTools, bypassing the RE class_method='query' platform bug.
   */
  groundingDataStores?: string[];
  /** Notes about lossy or heuristic mappings for the fidelity report. */
  fidelityNotes: FidelityNote[];
}

export interface FidelityNote {
  component: string;
  status: 'mapped' | 'partial' | 'lost' | 'needs-review';
  detail: string;
}

/** Outcome of pushing one mapped agent to Gemini Enterprise. */
export interface MigrationResult {
  sourceId: string;
  name: string;
  geminiAgentId?: string;
  created: boolean;
  deployed: boolean;
  /** True when `deployed` is false BECAUSE the source agent was a Draft in Copilot Studio (intentional, not a failure). */
  draftPreserved?: boolean;
  shared: boolean;
  verified?: boolean;
  verifySample?: string;
  error?: string;
  fidelity: FidelityNote[];
  /** Uploaded knowledge files attached to the agent (agentFiles). */
  knowledgeFilesUploaded?: number;
  knowledgeFilesFailed?: number;
  /** Dataverse reference-table rows snapshotted into a structured data store. */
  knowledgeTableRowsIndexed?: number;
  knowledgeTableRowsFailed?: number;
  /**
   * SharePoint/OneDrive "upload and sync" sources (FederatedStructuredSearchSource
   * — no auto-discoverable URL, see .claude/memory/decisions.md) that a
   * filename search found candidates for. NOT auto-attached — a person
   * reviews these and calls POST /api/migrate/knowledge-source-confirm with
   * the correct one. Empty candidates means the search found nothing.
   */
  knowledgeSourceCandidates?: {
    sourceName: string;
    scopedToUser?: string | null;
    candidates: {
      driveId: string;
      itemId: string;
      name: string;
      sizeBytes?: number;
      webUrl?: string;
      lastModifiedDateTime?: string;
      parentContext?: string;
    }[];
  }[];
  /** Manual permission steps when Gemini cannot apply per-principal sharing. */
  permissionHandoff?: PermissionHandoff;
}

/** Server-sent progress event to the browser. */
export type ProgressEvent =
  | { type: 'log'; level: 'info' | 'ok' | 'warn' | 'fail'; msg: string }
  | { type: 'progress'; pct: number; msg: string }
  | { type: 'agent'; result: MigrationResult }
  | { type: 'done'; summary: string; results: MigrationResult[] };
