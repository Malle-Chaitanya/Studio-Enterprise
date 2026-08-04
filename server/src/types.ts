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
}

/**
 * Agent-level SOURCE metadata (provenance). Preserved for the migration
 * report / audit trail — NOT migrated into Gemini, which has its own lifecycle
 * metadata (createTime/updateTime/state). Mirrors the Copilot "Agents" list
 * columns: Type, Owner, Last modified, Protection status, etc.
 */
export interface AgentSourceMetadata {
  type?: string; // e.g. "Agent"
  ownerId?: string; // systemuser/team id (name needs an expand — best-effort)
  createdOn?: string; // ISO
  modifiedOn?: string; // ISO  → Copilot "Last modified"
  lastPublished?: string; // ISO or undefined ("Never") — best-effort
  isManaged?: boolean; // part of a managed solution
  protected?: boolean; // Copilot "Protection status: Protected" (≈ managed)
  status?: string; // 'active' | 'inactive'
  schemaName?: string;
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

// ── Flow IR ──────────────────────────────────────────────────────────────────
// Normalized, platform-neutral representation of one Power Automate flow.
// Built by flowExtractor; consumed by flowMapper (rule-based) and Hermas
// (agent-based) to produce Cloud Workflow YAML.

/** How the flow is triggered. */
export type FlowTriggerType = 'Recurrence' | 'Webhook' | 'HttpRequest' | 'Manual' | 'Unknown';

/** One named input parameter for a Manual trigger ("Manually trigger a flow"). */
export interface FlowTriggerInput {
  type: string;
  description?: string;
  required?: boolean;
}

export interface FlowTrigger {
  type: FlowTriggerType;
  /** Raw Power Automate trigger kind (e.g. "OpenApiConnectionWebhook"). */
  rawType: string;
  /** Dataverse entity name for Webhook triggers (e.g. "leads", "opportunities"). */
  entity?: string;
  /** Create / Update / Delete for Webhook triggers. */
  message?: string;
  /** Column filter for Webhook triggers (only fire when this field changes). */
  filterExpression?: string;
  /** Recurrence interval in minutes (Recurrence triggers). */
  recurrenceMinutes?: number;
  /** Raw recurrence frequency + interval from PA definition. */
  recurrenceRaw?: { frequency: string; interval: number };
  /** Named input parameters for Manual ("Manually trigger a flow") triggers. */
  inputs?: Record<string, FlowTriggerInput>;
}

export interface FlowAction {
  name: string;
  /** Raw Power Automate action type (e.g. "OpenApiConnection", "If", "Foreach"). */
  type: string;
  /** Connector API name (e.g. "shared_commondataserviceforapps"). */
  connector?: string;
  /** The specific operation within the connector (e.g. "GetItem", "UpdateRecord"). */
  operationId?: string;
  /** Custom Dataverse action name when operationId is "PerformUnboundAction". */
  actionName?: string;
  /** Dataverse entity this action reads/writes. */
  entity?: string;
  /** Raw inputs from the PA flow definition — preserved for Hermas. */
  rawInputs?: Record<string, unknown>;
}

/** Connector used by the flow (from connectionReferences). */
export interface FlowConnector {
  /** Reference display name (e.g. "Dataverse", "Microsoft Copilot Studio for Sales"). */
  displayName: string;
  /** API name (e.g. "shared_commondataserviceforapps", "shared_microsoftcopilotstudio"). */
  apiName: string;
  /** True when we have a rule-based mapper for this connector. */
  known: boolean;
}

/**
 * Confidence score breakdown — explains why a flow scored as it did.
 * Surfaces in the UI so the customer understands what needs review.
 */
export interface FlowConfidenceBreakdown {
  /** 0–100 overall score. ≥80 = rule-based; 50–79 = hybrid; <50 = Hermas. */
  score: number;
  /** Connectors we have no rule-based mapper for. */
  unknownConnectors: string[];
  /** Action types we cannot deterministically translate. */
  unknownActions: string[];
  /** Questions we need the customer to answer before migrating. */
  gaps: FlowGap[];
  /** Which migration path this flow takes. */
  strategy: 'rule-based' | 'hybrid' | 'hermas' | 'unsupported';
}

/** A gap = one piece of information Hermas cannot determine — must ask the customer. */
export interface FlowGap {
  id: string;
  question: string;
  options?: string[];
  defaultOption?: string;
}

/**
 * FlowIR — Intermediate Representation of one Power Automate flow.
 * The single source of truth the migration pipeline works from.
 * Everything the mapper + Hermas could possibly need is captured here.
 */
export interface FlowIR {
  /** Dataverse workflowid. */
  sourceId: string;
  name: string;
  /** 0 = active, 1 = inactive. */
  statecode: number;
  trigger: FlowTrigger;
  actions: FlowAction[];
  connectors: FlowConnector[];
  confidence: FlowConfidenceBreakdown;
  /** Full raw clientdata JSON — sent to Hermas for unknown flows. */
  rawDefinition: Record<string, unknown>;
  /** Fields we extracted but have no mapping for yet. */
  unmapped: string[];
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
}

/** Destination-mapping options (how source environments map into Gemini). */
export interface DestinationOptions {
  /** Prefix each agent's display name with its source environment for traceability. */
  prefixWithEnv: boolean;
  /**
   * Per-source-environment target (env url → Gemini destination). This is the
   * real routing map: each Copilot environment's agents are created under its
   * mapped engine. V1 maps to EXISTING engines only (no auto-create).
   */
  environmentMap?: Record<string, GeminiDestination>;
  /** @deprecated legacy name-prefix map (env url → label). Superseded by environmentMap. */
  projects?: Record<string, string>;
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
  /**
   * How to handle knowledge sources Gemini can't import (websites, etc.).
   * Default 'report-only' (no instruction change); 'appendix' adds a separated
   * "Migrated Knowledge References" block; 'skip' omits them. Customer choice.
   */
  knowledgeHandling?: 'skip' | 'appendix' | 'report-only';
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
  shared: boolean;
  verified?: boolean;
  verifySample?: string;
  error?: string;
  fidelity: FidelityNote[];
  /** Uploaded knowledge files attached to the agent (agentFiles). */
  knowledgeFilesUploaded?: number;
  knowledgeFilesFailed?: number;
}

/** Server-sent progress event to the browser. */
export type ProgressEvent =
  | { type: 'log'; level: 'info' | 'ok' | 'warn' | 'fail'; msg: string }
  | { type: 'progress'; pct: number; msg: string }
  | { type: 'agent'; result: MigrationResult }
  | { type: 'done'; summary: string; results: MigrationResult[] };
