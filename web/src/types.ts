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

export interface AgentAssessment {
  agent: string;
  sourceId: string;
  summary: Record<Compatibility, number>;
  effort: 'low' | 'medium' | 'high';
  components: ComponentAssessment[];
  dependencies: DependencyRef[];
  knowledge?: KnowledgeAssessment;
}

export interface AgentBrief {
  botid: string;
  name: string;
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
  | { type: 'done'; summary: string; results: MigrationResult[] };
