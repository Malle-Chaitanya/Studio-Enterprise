export interface SessionSummary {
  step: string;
  orgName?: string;
  msEmail?: string;
  tenantId?: string;
  environments: number;
  botCount: number;
  topicCount: number;
  ksCount: number;
  flowCount: number;
  gEmail?: string;
  geminiProject?: string;
  saOk: boolean;
  saReason?: string;
  connected: { microsoft: boolean; google: boolean };
}

export interface FidelityNote {
  component: string;
  status: 'mapped' | 'partial' | 'lost' | 'needs-review';
  detail: string;
}

/**
 * Why we believe (or do not believe) a migrated agent works.
 *
 * `wrong_agent_tools` is the case this exists for: an agent reporting deployed
 * while running ANOTHER agent's tools. A partial overlap is deliberately NOT that
 * verdict — it is `tools_confirmed` with a non-empty `unexpected`, because calling
 * every ordinary gap a swap would make the scary verdict meaningless.
 */
export interface VerificationEvidence {
  verdict: 'tools_confirmed' | 'wrong_agent_tools' | 'prose_only' | 'not_probed';
  /** Tools we wired into the agent. */
  expected: string[];
  /** Tools that actually fired, read from function_call frames. */
  observed: string[];
  /** Fired but never wired — someone else's tool package. */
  unexpected: string[];
  /** Wired but never seen. */
  missing: string[];
  /** A tool RETURNED data, as opposed to merely being called. */
  returnedData: boolean;
}

export interface MigrationResult {
  sourceId: string;
  name: string;
  geminiAgentId?: string;
  created: boolean;
  deployed: boolean;
  /** `deployed: false` because the SOURCE was a Draft in Copilot Studio — the source's
   *  intent kept faithfully, not a half-finished deploy. Reporting it as "not published"
   *  turns a correct outcome into a defect. */
  draftPreserved?: boolean;
  shared: boolean;
  verified?: boolean;
  /**
   * The three-value truth behind `verified`. `unknown` means no probe could confirm the
   * agent works — distinct from `failed`, because the reader's next action differs: a
   * failure is a defect, an unknown is a check still owed.
   */
  verifyStatus?: 'verified' | 'failed' | 'unknown';
  verifySample?: string;
  /** The evidence BEHIND verifyStatus. The verdict is computed server-side on
   *  purpose: if the screen re-derived it, the UI and the report could reach
   *  different conclusions about the same run. Absent on older results. */
  verifyEvidence?: VerificationEvidence;
  error?: string;
  /** Connectors wired for THIS agent and how many operations each contributed as tools.
   *  Absent on runs recorded before the field existed — the report shows "—" rather than
   *  a zero, which would be a claim about the agent instead of about our own records. */
  connectorsWired?: { name: string; toolCount: number; actsAs?: string }[];
  /** Topic sub-agents wired into the deployed engine. */
  subAgents?: number;
  /** Source capabilities found, and how many reproduced at full fidelity. The honest
   *  version of 'did this migrate': created but reproducing 4 of 13 is not success. */
  capabilities?: { total: number; exact: number };
  fidelity: FidelityNote[];
  permissionHandoff?: {
    agentName: string;
    geminiAgentId?: string;
    reason: string;
    grantUsers: string[];
    grantGroups: string[];
    unresolved: { source: string; reason: string }[];
    steps: string[];
  };
}

export interface EnvironmentInfo {
  name: string;
  url: string;
  id: string;
  accessible: boolean;
  bots: number;
  topics: number;
  knowledgeSources: number;
  flows: number;
  /** Why an inaccessible environment is inaccessible, and the admin step that fixes it. */
  accessDenied?: {
    code: 'no_application_user' | 'forbidden' | 'unreachable';
    detail: string;
    fix?: string;
  };
}

export type Compatibility = 'supported' | 'partial' | 'manual' | 'none';

export interface ComponentAssessment {
  component: string;
  kind: string;
  compatibility: Compatibility;
  note: string;
}

export interface DependencyRef {
  type: string;
  ref: string;
  from: string;
}

export type KnowledgeDisposition = 'auto' | 'reconnect' | 'manual';

export interface KnowledgeAction {
  title: string;
  strategy: string;
  target: string;
  disposition: KnowledgeDisposition;
  detail: string;
  /** URLs/site paths this action operates over (reconnect targets: the site to configure a connector for). */
  references?: string[];
  fileCount?: number;
  incompatibleFiles?: string[];
}

export interface KnowledgeAssessment {
  total: number;
  autoCount: number;
  reconnectCount: number;
  manualCount: number;
  actions: KnowledgeAction[];
}

/** One source whose permissions cannot be carried across. */
export interface AclLossItem {
  source?: string;
  detail?: string;
  readableBy?: string;
}

/**
 * Whether migrating this agent INVERTS a permission.
 *
 * `inverts` is the server's own predicate — the same function that used to gate
 * the run — not a proxy for it. "Has knowledge sources" is wider than the truth:
 * a public website source has no permissions to lose, so keying on it would ask
 * an operator to accept an exposure that is not happening.
 */
export interface PermissionLoss {
  inverts: boolean;
  items: AclLossItem[];
  orgWide: boolean;
  /** The concrete sentence. Empty when nothing inverts. */
  summary: string;
}

export interface AgentAssessment {
  agent: string;
  sourceId: string;
  summary: Record<Compatibility, number>;
  effort: 'low' | 'medium' | 'high';
  components: ComponentAssessment[];
  dependencies: DependencyRef[];
  knowledge?: KnowledgeAssessment;
  permissionLoss?: PermissionLoss;
}

export interface AgentBrief {
  botid: string;
  name: string;
  /** Knowledge sources on this agent, from the list response. There is NO
   *  topicCount: the row count and the staged count disagree and the relationship
   *  is not understood yet, so no topic number is claimed here. */
  knowledgeCount?: number;
  ownerId?: string;
  ownerEmail?: string;
  ownerDisplayName?: string;
  accessLabel?: string;
  accessPolicy?: string;
}

export interface MigrationScope {
  kind: 'agents' | 'environments' | 'tenant' | 'selection';
  env?: string;
  botIds?: string[];
  envs?: string[];
  units?: { env: string; botIds: string[] }[];
}

export interface PlanPreview {
  totalAgents: number;
  environments: { name: string; agents: string[] }[];
  destination: Record<string, unknown>;
  dryRun?: boolean;
}

export type ProgressEvent =
  | { type: 'log'; level: 'info' | 'ok' | 'warn' | 'fail'; msg: string }
  | { type: 'progress'; pct: number; msg: string }
  | { type: 'agent'; result: MigrationResult }
  | { type: 'done'; summary: string; results: MigrationResult[] }
  /* The agent-driving kinds. `target` is a HINT: it names a `data-agent-target`
     the server GUESSES we rendered, and the server cannot know what we drew, so
     an unresolvable target is ignored silently rather than treated as an error.
     `ok` on tool_end is the TOOL's verdict, not the transport's — a 200 carrying
     an error payload is ok:false. */
  | { type: 'tool_start'; tool: string; target?: string; msg: string }
  /* `outcome` is additive and `ok` stays a plain boolean: an unknown sends
     ok:false, so a consumer that ignores `outcome` fails CLOSED and no green tick
     can leak through. Read `outcome` to colour the middle state — never infer it
     from `msg`, or a wording change becomes a rendering bug. */
  | { type: 'tool_end'; tool: string; target?: string; ok: boolean;
      outcome?: 'ok' | 'failed' | 'unknown'; msg: string }
  | { type: 'awaiting_human'; reason: string; target?: string; msg: string };

/** The run's own header row -- who it ran between, when, how long. Every field is
 *  optional because the report renders without it: a run whose results exist but whose
 *  header row does not still has something worth showing. */
export interface RunHeader {
  runId: string;
  orgName?: string;
  status?: string;
  startedAt?: string;
  finishedAt?: string;
}
