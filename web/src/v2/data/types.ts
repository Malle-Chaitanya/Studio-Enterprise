/**
 * The data seam.
 *
 * v2 screens NEVER call `fetch` or `api.ts` directly. They take a source, and the
 * source is either the real backend or a fixture. That is what makes "build the
 * frontend now, connect the backend later" a real plan instead of a promise: when
 * a phase's endpoints are ready we fill in one method here, and no screen changes.
 *
 * It also makes the whole UI reviewable with no tenant, which is the only way the
 * eight screens can be iterated on at speed.
 *
 * Rule for anything added below: a method returns FACTS the backend can actually
 * produce. If we cannot get a number honestly, the type does not carry it — an
 * optional field the fixture fills and the API never can is how a UI starts lying.
 */

import type { ConnectorRequirement, ConnectorValidation, DetectedConnector, SavedConnector } from '../../api.ts';

/** One connector as the Connectors screen needs it. */
export interface ConnectorRow {
  connectorId: string;
  name: string;
  /** Agents that reference it — the answer to "why is this here?". */
  agentNames: string[];
  flowNames: string[];
  detected: DetectedConnector | null;
  req: ConnectorRequirement | null;
  saved: SavedConnector | null;
  /** Fields with no value in Secret Manager yet. Only a human can supply these. */
  missingFields: string[];
  state: 'ready' | 'needs-you' | 'wrong-project' | 'cannot-migrate';
}

/** Environments the customer selected agents from. Carried so scans stay scoped. */
export interface ScopeEnv {
  env: string;
  botIds: string[];
}

export interface ConnectorScan {
  rows: ConnectorRow[];
  envs: ScopeEnv[];
}

export interface ConnectorsSource {
  /** Discover the connectors this migration depends on, and what each still needs. */
  scan(session: string): Promise<ConnectorScan>;
  /** Re-read ONE connector's requirements. The agent calls this per row, so each
   *  cursor move corresponds to a request that really happened. */
  requirements(session: string, connectorId: string, env?: string): Promise<ConnectorRequirement | null>;
  /** Write credential values (to Secret Manager) and report what validation said. */
  save(
    session: string,
    connectorId: string,
    creds: Array<{ field: string; value: string }>,
  ): Promise<{ validation?: ConnectorValidation }>;
  /** Forget our record of a connector. Leaves the secrets themselves untouched. */
  forget(session: string, connectorId: string): Promise<void>;
}

/**
 * Everything the v2 screens can read. One namespace per phase, added as each
 * screen lands — a phase with no entry here has no screen yet.
 */


// ── connect ─────────────────────────────────────────────────────────────────

/** One side of the migration. `account` is who we are acting as, never a token. */
export interface CloudLink {
  platform: 'microsoft' | 'google';
  connected: boolean;
  account?: string;
  detail?: string;
  /** Present only when the service account cannot reach the destination. */
  problem?: string;
}

export interface ConnectState {
  source: CloudLink;
  destination: CloudLink;
  /** Counts discovered after connecting. Absent until we have really read them. */
  found?: { environments: number; agents: number; topics: number };
}

export interface ConnectSource {
  read(session: string): Promise<ConnectState>;
  disconnect(session: string, platform: 'microsoft' | 'google'): Promise<void>;
}

// ── environments -> projects ────────────────────────────────────────────────

export interface EnvRow {
  url: string;
  name: string;
  accessible: boolean;
  agents: number;
  topics: number;
}

export interface DestOption {
  project: string;
  name?: string;
  engines: Array<{ id: string; displayName: string }>;
}

/** One environment pointed at one Gemini app. Both must be set to be usable. */
export interface EnvPair {
  env: string;
  project?: string;
  engine?: string;
}

export interface PairSource {
  environments(session: string): Promise<EnvRow[]>;
  destinations(session: string): Promise<DestOption[]>;
  read(session: string): Promise<EnvPair[]>;
  save(session: string, pairs: EnvPair[]): Promise<void>;
}

// ── users ───────────────────────────────────────────────────────────────────

/**
 * One identity to carry across. Deliberately NO confidence score: a percentage
 * next to a person's name invites trusting a guess. Either we found the match, or
 * we are asking.
 */
export interface UserRow {
  sourceId: string;
  sourceEmail: string;
  sourceName?: string;
  /** Our proposal. It is shown as a proposal, and never applied silently. */
  suggested?: string;
  mapped?: string;
  state: 'mapped' | 'suggested' | 'unmapped';
}

export interface UsersSource {
  list(session: string): Promise<UserRow[]>;
  /** Destination accounts, for the picker. */
  candidates(session: string, query: string): Promise<Array<{ email: string; name?: string }>>;
  save(session: string, map: Record<string, string>): Promise<void>;
}

// ── agents ──────────────────────────────────────────────────────────────────

export interface AgentRow {
  botId: string;
  name: string;
  env: string;
  envName: string;
  owner?: string;
  topics: number;
  knowledge: number;
}

export interface AgentsSource {
  list(session: string, envs: string[]): Promise<AgentRow[]>;
  /** Persist the selection the later phases are scoped to. */
  saveSelection(session: string, selection: Array<{ env: string; botIds: string[] }>): Promise<void>;
}

// ── review ──────────────────────────────────────────────────────────────────

export type Verdict = 'clean' | 'needs-review' | 'lost';

export interface ReviewFinding {
  verdict: Verdict;
  component: string;
  detail: string;
}

/** What migrating ONE agent will really do. Shown before anything is written. */
export interface ReviewRow {
  botId: string;
  name: string;
  env: string;
  effort: 'low' | 'medium' | 'high';
  counts: Record<Verdict, number>;
  findings: ReviewFinding[];
}

export interface ReviewSource {
  /** Assess one agent. Per-agent on purpose: it is a real call each time, so the
   *  agent's cursor can only advance on a result that actually came back. */
  assess(session: string, agent: { botId: string; name: string; env: string }): Promise<ReviewRow>;
}

// ── migrate ─────────────────────────────────────────────────────────────────

export interface RunLine {
  level: 'info' | 'ok' | 'warn' | 'fail';
  msg: string;
}

export interface RunAgent {
  name: string;
  state: 'queued' | 'running' | 'done' | 'failed';
  note?: string;
}

export interface RunUpdate {
  pct?: number;
  line?: RunLine;
  agent?: RunAgent;
  /** Set once, when the run has finished. */
  finished?: { summary: string };
}

export interface MigrateSource {
  /** Begin a run. `dryRun` really means nothing is written to Gemini. */
  start(session: string, opts: { dryRun: boolean }): Promise<void>;
  /** Stream progress. Returns an unsubscribe. */
  subscribe(session: string, onUpdate: (u: RunUpdate) => void): () => void;
}

// ── report ──────────────────────────────────────────────────────────────────

export interface ReportRow {
  name: string;
  env: string;
  ok: boolean;
  verified?: boolean;
  url?: string;
  counts: Record<Verdict, number>;
  findings: ReviewFinding[];
}

export interface ReportSource {
  list(session: string): Promise<ReportRow[]>;
}

export interface V2Source {
  /** True when this is canned data. The shell shows a banner, so a screenshot of
   *  fixture data can never be mistaken for a customer's migration. */
  readonly isFixture: boolean;
  connect: ConnectSource;
  pair: PairSource;
  users: UsersSource;
  agents: AgentsSource;
  review: ReviewSource;
  connectors: ConnectorsSource;
  migrate: MigrateSource;
  report: ReportSource;
}
