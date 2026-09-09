import type { TopicGraph } from './services/topicGraph.js';
import type { KnowledgeClassification } from './services/knowledgeClassifier.js';
import type { ToolInputIR, ToolOutputFieldIR, McpBindingIR } from './services/toolPayload.js';
import type { VerificationEvidence } from './services/verify.js';

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
  /**
   * True when this topic is actually a Copilot Studio "child agent" (the GA
   * multi-agent construct — a nested agent with its own instructions and, often,
   * its own private tools), not an ordinary conversational topic.
   *
   * Live-confirmed 2026-08-31 against a real child agent ("Meeting Scheduler
   * Agent" on the "WorkMate" test agent): a child agent extracts as a
   * `componenttype: 9` row exactly like any topic, but its raw YAML top-level
   * `kind` is `AgentDialog` (with `beginDialog.kind: OnToolSelected`) — never
   * `AdaptiveDialog`, the kind an ordinary topic uses. See
   * `isChildAgentComponent` in `services/dataverse.ts`.
   *
   * Earlier session hypothesis (`kind: InlineAgentSkill`, `isInlineSkillComponent`)
   * was FALSIFIED by this live data — that pattern is real but is a different,
   * older construct, not the GA child-agent feature.
   */
  isChildAgent?: boolean;
  /**
   * The child agent's own REAL authored instructions (`settings.instructions` in its
   * `kind: AgentDialog` YAML) — a completely different field from `modelDescription`
   * above, which is only the short routing description shown to the parent's router.
   *
   * Live-confirmed 2026-08-31/09-01: without this, a real child agent's actual behavior
   * rules (e.g. "always collect the meeting title, date, attendees, and duration before
   * booking — never guess") were silently dropped. Mapping fell back to a generic
   * placeholder instruction meant for flattening an ordinary migrated TOPIC into an ADK
   * sub-agent, and the migrated sub-agent booked meetings without asking for a title or
   * duration — a real, user-visible behavior regression from the source agent, not a
   * model-behavior difference between Copilot Studio and Gemini.
   */
  childAgentInstructions?: string;
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
   * - agent-viewer — a Read-only row-share. NOTE: native Copilot Studio actually has TWO
   *   separate roles here — "Analytics Viewer" (Analytics page, individual-only) and
   *   "Agent viewer" (Evaluation page, individual or group) — confirmed distinct, separately
   *   documented mechanisms (learn.microsoft.com/en-us/microsoft-copilot-studio/admin-share-bots,
   *   fetched 2026-08-20). This single value currently buckets both together; splitting it into
   *   'analytics-viewer' | 'evaluation-viewer' is pending a live-tenant diagnostic spike to
   *   confirm the two are even distinguishable in the row-share signal this decodes from — see
   *   docs/design/permission-mapping.md §2.1. Do not assume "often blocked when the user already
   *   has Environment Maker" — that claim is unverified and not in the current official docs.
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
  via: 'override' | 'email-match' | 'email-match-unverified' | 'username-match' | 'group-match' | 'unmatched';
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
  /**
   * Copilot Studio Agent Flows this agent invokes (the `flow` AgentToolIR kind's real
   * definition — `AgentToolIR.flowId` is the join key). Optional and additive: an agent
   * with no flows simply omits it, and every existing consumer of AgentIR is unaffected.
   *
   * Flows are extracted here (Dataverse `workflows.clientdata`) but mapped into a Gemini
   * Application Integration definition separately (see `services/flowMapper.ts`) — the
   * translated result rides on `MappedAgent.flowIntegrations`, never here, keeping this
   * field a pure extraction artifact per the extract/map phase boundary.
   */
  flows?: FlowIR[];
}

/** One trigger input field on a flow (`triggers.manual.inputs.schema.properties`). */
export interface FlowParameterIR {
  /** WDL schema property key, e.g. "text_1". */
  name: string;
  /** The schema property's `description` — the human-meaningful field name the author
   *  gave it, e.g. " NewLimit" for a field literally named "text_1". */
  displayName?: string;
  /**
   * The schema property's real JSON Schema `type` (confirmed live: a Copilot "Number"
   * field extracts as `type: "number"` with `x-ms-content-hint: "NUMBER"`, not as text —
   * so this is read directly from the schema, not inferred from content-hint alone).
   * Drives lossless typing on the Gemini side (INT_VALUE vs STRING_VALUE) — a real bug
   * this session traced to a Number field migrated as STRING_VALUE silently swallowing
   * comma-formatted input.
   */
  dataType: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'unknown';
  required?: boolean;
}

/** A flow's entry trigger (`triggers.manual` in WDL — always `type: Request, kind: Skills` in the flows seen so far, but stored verbatim rather than assumed). */
export interface FlowTriggerIR {
  type: string;
  kind?: string;
  inputSchema: FlowParameterIR[];
  /** Full raw trigger JSON, preserved losslessly for manual review. */
  raw?: unknown;
}

/** One `connectionReferences` entry — a connector the flow calls, e.g. "shared_teams". */
export interface FlowConnectionReferenceIR {
  /** The connectionReferences key used inside the flow's actions (host.connectionName). */
  name: string;
  /** Registry connector id resolved from `api.name`'s ARM path, e.g. `shared_teams`. */
  connectorId?: string;
  raw?: unknown;
}

/**
 * One node in a flow's action graph (WDL `actions` / `else.actions` / `cases[].actions`).
 * Recursive and generic — `type` is preserved VERBATIM (Compose, Response, OpenApiConnection,
 * If, Switch, Foreach, Scope, Until, or anything else WDL allows) rather than narrowed to a
 * fixed enum, so an unrecognized action still round-trips losslessly via `raw` and surfaces
 * as `unmapped`/a fidelity note downstream instead of being silently dropped at extraction.
 */
export interface FlowActionIR {
  /** WDL action key, e.g. "Post_message_in_a_chat_or_channel". */
  id: string;
  /** Raw WDL `type`, verbatim. */
  type: string;
  /** Other action ids this one must run after, and the required statuses. */
  runAfter: Record<string, string[]>;
  /** Full raw action JSON — lossless, mirrors TopicIR.raw. */
  raw: unknown;
  // Best-effort parsed facade below, populated only when `type` is recognized. Absence of
  // a facade field does NOT mean data loss — `raw` always has the full definition.
  compose?: { template: unknown };
  response?: { statusCode?: number; bodyTemplate?: unknown; schema?: unknown };
  connector?: {
    connectionReferenceName: string;
    apiId?: string;
    operationId?: string;
    parameters?: Record<string, unknown>;
  };
  /** `If` action's `expression`. */
  condition?: unknown;
  /** `Switch` action's `expression`. */
  switchOn?: unknown;
  /** Branches for `If` ('true'/'false'), `Switch` (case values + 'default'), or similar. */
  branches?: { label: string; actions: FlowActionIR[] }[];
}

/**
 * One Copilot Studio Agent Flow, extracted losslessly from Dataverse `workflows.clientdata`
 * (Azure Logic Apps Workflow Definition Language JSON). See `AgentIR.flows` for how this
 * plugs into the pipeline and `services/flowMapper.ts` for how it becomes a Gemini
 * Application Integration definition.
 */
export interface FlowIR {
  /** Dataverse workflow id — SAME value as the owning `AgentToolIR.flowId`, and the
   *  deterministic identity used downstream for idempotent Application Integration naming. */
  id: string;
  name: string;
  /** The `AgentToolIR.name` that invokes this flow, when known. */
  ownerToolName?: string;
  trigger?: FlowTriggerIR;
  /** Top-level action graph, in WDL's own key order (dependency order is read from `runAfter`, never assumed from array position). */
  actions: FlowActionIR[];
  connectionReferences: FlowConnectionReferenceIR[];
  /** Full raw clientdata JSON, verbatim. */
  raw?: unknown;
  /** Extraction-time gaps (unrecognized top-level shape) — same convention as `AgentIR.unmapped`. */
  unmapped: string[];
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
  /** A custom API the author added in Copilot Studio (`InvokeAIPluginTaskAction`). */
  | 'ai-plugin'
  /** A Power Automate flow (`InvokeFlowTaskAction`) — only its id is in the payload. */
  | 'flow'
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
  /**
   * The arguments the AUTHOR bound: which are pinned to a value and which the model fills.
   *
   * This is what separates reproducing the call from reproducing the call's shape. A tool
   * whose `entityName` was pinned to one table becomes, without this, a tool the model can
   * point at any table.
   */
  inputs?: ToolInputIR[];
  /** Declared result shape, flattened. Lets the migrated tool describe its output. */
  outputSchema?: ToolOutputFieldIR[];
  /** For `mcp-server` tools: the server operation and the tools the author allowed. */
  mcp?: McpBindingIR;
  /** For `flow` tools: the Power Automate flow id. The flow itself is not migrated yet. */
  flowId?: string;
  /** For `ai-plugin` tools: the plugin identity from `entityKey`. */
  aiPlugin?: { name?: string; operationId?: string };
  /**
   * Set when the call was embedded in a TOPIC rather than declared as a standalone tool
   * (`InvokeConnectorAction` inside an AdaptiveDialog). The migrated tool preserves the
   * capability, not the topic's ordering or conditions — callers must report that.
   */
  sourceTopic?: string;
  /** Dataverse schema name of the component. */
  schemaName?: string;
  /**
   * Set when this tool is privately owned by a child-agent topic (`TopicIR.isChildAgent
   * === true`) rather than belonging to the root agent — the id of that owning `TopicIR`.
   *
   * NOT the same fact as `sourceTopic` above, which means "this call was embedded inline
   * inside a topic's own dialog graph." This field means "this tool's `botcomponent` row
   * is a genuine standalone TaskDialog, but Dataverse's own `ParentBotComponentId` lookup
   * says a child-agent topic — not the root bot — owns it."
   *
   * Live-confirmed 2026-08-31: Dataverse's `botcomponents` entity has a real
   * `_parentbotcomponentid_value` lookup field (distinct from `_parentbotid_value`, which
   * always points at the root bot). For a standalone child agent's own tool components,
   * this field is populated with the owning child-agent topic's `botcomponentid`; for the
   * root agent's own tools it was observed null. See `services/dataverse.ts`'s
   * `extractAgent` — this is where the "which tools belong to WorkMate vs. which belong to
   * Meeting Scheduler Agent" ambiguity found earlier this session actually gets resolved.
   */
  childAgentTopicId?: string;
  /**
   * Set during Phase 2 INSERT (never at extraction — extraction stays platform-neutral)
   * when this tool is a live Dataverse connector (`connectorId` starts with
   * `shared_commondataserviceforapps`) AND the customer chose "Use Cloud SQL" for this
   * agent's Dataverse surface (a per-agent decision — see
   * db/repos/agentSurfaceChoice.ts's `shared_commondataserviceforapps` entry, the same
   * "Keep Microsoft / Use Google equivalent" mechanism already used for Outlook/Teams). The
   * tool's table has been copied into Cloud SQL and the deployed agent queries Postgres
   * instead of calling Dataverse live. See services/cloudSqlMigration.ts.
   *
   * Absent whenever "Keep Dataverse" was chosen (explicitly, or by default when nothing was
   * decided — see `defaultDecision`'s own doc comment) or the tool is not a Dataverse
   * connector — the deployed tool then falls through to today's behavior
   * (`connector_tools/generic_rest.py` calling Dataverse live). Additive/optional: an IR
   * staged before this field existed simply lacks it and behaves exactly as before.
   */
  cloudSqlTarget?: {
    instanceConnectionName: string; // "<project>:<region>:<instance>", the Cloud SQL Connector's own address format
    database: string;
    table: string;
    /** The Dataverse primary-key attribute, kept as the Postgres primary key column name
     *  too — re-running the copy upserts by this key instead of duplicating rows. */
    primaryKeyAttr: string;
    /**
     * The table's real column names, in order. NOT optional, NOT decorative: the deployed
     * Python tool (connector_tools/cloudsql.py) validates a model-supplied filter COLUMN
     * against this exact list before using it in a query — SQL identifiers cannot be
     * parameterized, so an allowlist is the injection defense, and this is that allowlist.
     * The filter VALUE is always sent as a real parameterized bind, never interpolated.
     */
    columns: string[];
  };
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
  /**
   * The customer has been shown, and accepted, that indexed knowledge loses its source
   * permissions (see services/aclDisclosure.ts). Without this the run stops between the
   * extract and insert phases rather than silently over-sharing restricted content.
   *
   * Deliberately not persisted with the session's other preferences: it is an
   * acknowledgement of a specific set of sources at a specific moment, so it must be given
   * again if the plan changes.
   */
  acknowledgeAclLoss?: boolean;
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
  /**
   * One entry per `AgentIR.flows[]`, produced by `services/flowMapper.ts` — a pure,
   * offline (no network) translation of the flow's action graph into an Application
   * Integration definition. Insert phase (`services/applicationIntegration.ts`) creates
   * these; nothing here has touched Google yet. Optional/additive: an agent with no
   * flows omits it.
   */
  flowIntegrations?: MappedFlowIntegration[];
}

export interface FidelityNote {
  component: string;
  status: 'mapped' | 'partial' | 'lost' | 'needs-review';
  detail: string;
}

/**
 * The result of translating one `FlowIR` into a Google Application Integration
 * definition — still Phase 1 output (pure/offline), staged alongside the agent so a
 * failed Phase 2 insert never needs to re-extract or re-translate. See
 * `services/flowMapper.ts` (the translator) and `services/applicationIntegration.ts`
 * (what actually creates this in Google, during Phase 2).
 */
export interface MappedFlowIntegration {
  /** Same as the source `FlowIR.id` — the idempotency key `db/repos/flowIntegrations.ts` looks up by. */
  flowId: string;
  flowName: string;
  /** The full Application Integration `integrationDefinition` JSON body, ready for `versions:upload`. */
  integrationDefinition: unknown;
  /** Trigger input parameters the deployed ADK tool must pass through, with their inferred Gemini dataType. */
  inputParameters: FlowParameterIR[];
  /** Connectors this flow needs an AuthConfig for, resolved via the SAME registry/credential
   *  path as agent-level connector tools — never a separate credential system. */
  authConfigsNeeded: { connectorId: string; connectionReferenceName: string; authConfigName: string }[];
  /** Per-action/per-expression fidelity notes from translation (splice-and-report fallback
   *  for anything not confidently reproducible) — merged into the agent's overall fidelity report. */
  fidelityNotes: FidelityNote[];
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
  /**
   * The three-value truth behind `verified`.
   *
   * `unknown` means the probe could not run (endpoint unavailable, network, no readable
   * answer) — the agent was created but nothing established that it works. It is reported
   * separately from `failed` because the customer action differs: a failure names a
   * defect, an unknown names a check somebody still has to do by hand.
   */
  verifyStatus?: 'verified' | 'failed' | 'unknown';
  verifySample?: string;
  /**
   * What verification actually observed, so the report can show WHAT RAN rather than only a
   * verdict. Shape and the four-state rule live in services/verify.ts. Absent on results
   * from before this field existed, and on any path that never probed.
   */
  verifyEvidence?: VerificationEvidence;
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
  /**
   * The connectors actually wired for THIS agent, and how many operations each
   * contributed as tools.
   *
   * Recorded because it was the one thing a customer wanted from the report and the one
   * thing the report could not answer: "5 connectors, 31 tools" existed only in the live
   * run log, so it was gone the moment the screen was closed or the container restarted.
   * Only connectors this agent references are listed — a credential configured but never
   * called is not a capability this agent has.
   *
   * Optional: results written before this field existed have none, and the report shows
   * the connector names it can prove rather than a fabricated zero.
   */
  connectorsWired?: { name: string; toolCount: number; actsAs?: string }[];
  /**
   * Agent Flows actually created as Application Integration tools for THIS agent, and how
   * much of each flow's action graph translated. Mirrors `connectorsWired`'s honesty
   * convention: `lostTaskCount` > 0 means part of that flow's real behavior did not make
   * it across (e.g. a blocked Teams post, or an unresolvable expression) — never hidden by
   * reporting only that the flow "exists" as a tool.
   */
  flowsWired?: { name: string; taskCount: number; lostTaskCount: number; integrationName?: string }[];
  /** Topic sub-agents wired into the deployed engine. */
  subAgents?: number;
  /** Source capabilities found, and how many were reproduced at full fidelity. Shown as
   *  the agent's headline because it is the honest version of 'did this migrate' -- a
   *  created agent that reproduces 4 of 13 capabilities is not a successful migration. */
  capabilities?: { total: number; exact: number };
  /** Manual permission steps when Gemini cannot apply per-principal sharing. */
  permissionHandoff?: PermissionHandoff;
}

/** Server-sent progress event to the browser. */
/**
 * `target` names the DOM element a UI may point at — it must match a `data-agent-target`
 * attribute on the page. It is a HINT, never a promise: the server does not know what the
 * client rendered, so a target that does not resolve must be ignored silently rather than
 * treated as an error.
 */
export type ProgressEvent =
  | { type: 'log'; level: 'info' | 'ok' | 'warn' | 'fail'; msg: string }
  | { type: 'progress'; pct: number; msg: string }
  | { type: 'agent'; result: MigrationResult }
  /**
   * A tool call BEGAN. Emitted only for work actually starting — never speculatively, and
   * never on a schedule. The UI is entitled to move its cursor on this, which is precisely
   * why it must not fire for anything that has not really happened.
   */
  | { type: 'tool_start'; tool: string; target?: string; msg: string }
  /**
   * A tool call ENDED.
   *
   * `ok` is the tool's own verdict, not the HTTP status — a 200 carrying an error payload is
   * `ok: false`.
   *
   * `outcome` carries the THREE-value truth, because `ok` alone cannot. A step that could not
   * be established is not a step that failed: rendering "we could not check" in the same red
   * as "we checked and it is broken" is the exact collapse the verified/unknown split exists
   * to prevent, merely moved from the result chip into the step line. `ok` stays `false` for
   * an unknown so nothing green can leak through a consumer that ignores `outcome`, and a
   * consumer that reads it can colour the middle state properly. Optional so the field is
   * additive — older consumers keep working unchanged.
   */
  | {
      type: 'tool_end';
      tool: string;
      target?: string;
      ok: boolean;
      outcome?: 'ok' | 'failed' | 'unknown';
      msg: string;
    }
  /**
   * The run cannot proceed without a person. Distinct from a `log` at warn level: a warning
   * is something to read afterwards, this is a stop that owns the screen until it is
   * cleared. Also persisted on the session (`awaitingHuman`) so a browser refresh does not
   * lose the fact that it is the operator's turn.
   */
  | { type: 'awaiting_human'; reason: string; target?: string; msg: string }
  | { type: 'done'; summary: string; results: MigrationResult[] };

/** The pending handoff stored on a session, so a refresh does not lose it. */
export interface AwaitingHuman {
  reason: string;
  target?: string;
  msg: string;
  /** Epoch ms, so the UI can say how long it has been waiting. */
  since: number;
}
