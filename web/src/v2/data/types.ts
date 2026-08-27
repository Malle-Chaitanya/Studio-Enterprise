import type { PermissionLoss } from '../../types.ts';
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

import type {
  ConnectorRequirement, ConnectorValidation, DetectedConnector, DirectoryFilter, SavedConnector,
} from '../../api.ts';

/** One connector as the Connectors screen needs it. */
export interface ConnectorRow {
  connectorId: string;
  name: string;
  /** Agents that reference it — the answer to "why is this here?". */
  agentNames: string[];
  /**
   * The same agents by botid.
   *
   * Names were the only key the scan used to expose, so a per-agent decision could
   * only be matched by display name — which dropped any agent whose name did not
   * resolve, and collided when two agents shared one. Ids are a superset and exact.
   */
  agentIds: string[];
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
  /** Disconnecting the source (Microsoft) ends the whole session server-side —
   *  callers must check `sessionEnded` rather than re-reading the now-dead id. */
  disconnect(session: string, platform: 'microsoft' | 'google'): Promise<{ sessionEnded?: boolean }>;
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
  /** ASSIGNED Gemini Enterprise seats in this project. Undefined when unreadable —
   *  distinct from 0, which means "readable, genuinely no seats". */
  licenseCount?: number;
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
  /** True when a selected agent actually references this person — an owner, an
   *  editor, or someone it is shared with. False for a directory account nobody's
   *  agent mentions, which is still mappable but is not evidence of anything. */
  referenced?: boolean;
  /** This person came from a BOUNDED sample of agents, taken because no selection
   *  existed yet. The list is therefore incomplete and must say so. */
  sampled?: boolean;
  /** Our proposal. It is shown as a proposal, and never applied silently. */
  suggested?: string;
  mapped?: string;
  state: 'mapped' | 'suggested' | 'unmapped';
}

/** The destination directory as offered to the picker, WITH what was left out. */
export interface CandidatePage {
  users: Array<{ email: string; name?: string }>;
  truncated?: boolean;
  filter?: DirectoryFilter;
}

export interface UsersSource {
  /**
   * People to map.
   *
   * Two sources, deliberately merged rather than one or the other: the principals
   * the selected agents reference (which is empty before agents are picked, and
   * that is WHY this screen used to look broken), and the source tenant's own
   * directory. Referenced people are flagged so the screen can lead with them
   * without pretending the rest do not exist.
   */
  list(session: string): Promise<UserRow[]>;
  /** Destination accounts for the picker. `all` asks for the unfiltered directory —
   *  an admin diagnosing a missing colleague has to be able to see the disabled
   *  account, or the filter itself is unexplainable. */
  candidates(session: string, query: string, all?: boolean): Promise<CandidatePage>;
  save(session: string, map: Record<string, string>): Promise<void>;
  /**
   * How many people are mapped ON THE SERVER.
   *
   * The rail used to tick "Map users" only from a marker this browser wrote, so a
   * mapping saved in an earlier tab — or by the old wizard — showed as untouched
   * even though the run log printed "Identity map: 3 user override(s)". The tick is
   * a claim about the migration, so it has to come from where the migration reads
   * it.
   */
  mappedCount(session: string): Promise<number>;
  /**
   * The directory half only — people, plus whatever mapping is already saved.
   *
   * `list()` also discovers which people the agents REFERENCE, which is one ACL
   * read per agent and the reason this screen took tens of seconds before showing
   * anything. This returns the part that is one fast call, so the table is on
   * screen while the slow half is still being read.
   */
  directory(session: string): Promise<UserRow[]>;
  /**
   * Same-person matches for people who have none yet, from the SERVER's matcher.
   *
   * Deliberately not reimplemented here. The rule is not "same string before the @":
   * it checks the source address against the org's owned domains, against the
   * destination's verified Workspace addresses, and falls back to a username match
   * across domains only when the literal address is not a real account. A second copy
   * in the browser would drift from the one the migration actually resolves owners
   * with, and the drift would show up as an agent shared with the wrong person.
   */
  /**
   * Server-side match for people with no saved mapping.
   *
   * `refresh` forces the organization profile to be rebuilt rather than served from the
   * server's per-session cache — the Rescan button, and nothing else, should pass it.
   */
  autoMatch(
    session: string,
    people: UserRow[],
    refresh?: boolean,
  ): Promise<Record<string, string>>;
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
  /** Whether migrating this agent turns a restricted source into one readable by
   *  anyone who can use the agent. The server's verdict, never re-derived here. */
  permissionLoss?: PermissionLoss;
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

/**
 * Why we believe an agent works, mirrored from the server. The verdict is the
 * server's — the screen renders it and never recomputes it, so the UI and the
 * fidelity report cannot disagree about the same run.
 */
export interface RunEvidence {
  verdict: 'tools_confirmed' | 'wrong_agent_tools' | 'prose_only' | 'not_probed';
  expected: string[];
  observed: string[];
  /** Fired but never wired — another agent's tool package. */
  unexpected: string[];
  missing: string[];
  returnedData: boolean;
}

export interface RunAgent {
  name: string;
  /** The Copilot source id. Carried because the server's step targets are
   *  `agent:<sourceId>` — without it the cursor has nothing to point at. */
  sourceId?: string;
  /**
   * `created` and `verified` are separate states on purpose, and neither is called
   * "done". A deployed agent has been observed running ANOTHER agent's tools while
   * reporting deployed=true, so "we wrote it" is not evidence that "it works".
   * Only `verified` means something actually answered.
   */
  /**
   * `staged` is the DRY RUN outcome: extracted, mapped and written to the staging
   * DB, with nothing created in Gemini. It exists because `created: false` was
   * being read as failure, so a completely successful dry run reported every agent
   * as failed — the opposite of what happened.
   */
  state: 'queued' | 'running' | 'staged' | 'created' | 'verified' | 'failed';
  note?: string;
  evidence?: RunEvidence;
}

/**
 * A step the server actually performed, or a handoff it actually reached.
 *
 * `target` is a HINT at a `data-agent-target` value: the server cannot know what
 * this screen rendered, so an unresolvable target is ignored silently and the
 * cursor simply stays where it is. `ok` is the tool's verdict, not the
 * transport's — a 200 carrying an error payload is ok:false.
 */
export interface RunStep {
  phase: 'start' | 'end';
  tool: string;
  target?: string;
  ok?: boolean;
  /** The three-value truth behind `ok`. 'unknown' is a check still owed, not a
   *  defect — it must render amber, never red and never green. Absent on steps
   *  that predate the field; absent means fall back to `ok`. */
  outcome?: 'ok' | 'failed' | 'unknown';
  msg: string;
}

export interface RunHandoff {
  reason: string;
  target?: string;
  msg: string;
}

export interface RunUpdate {
  pct?: number;
  line?: RunLine;
  agent?: RunAgent;
  /** A real tool call, start or end. Drives the cursor — nothing else may. */
  step?: RunStep;
  /** The run has stopped and needs a human. Amber, never blue. */
  handoff?: RunHandoff;
  /** The event stream itself broke. Not a run failure — a transport failure, and
   *  the distinction matters: the run may still be going on the server. */
  streamError?: string;
  /** Set once, when the run has finished. */
  finished?: { summary: string };
}

export interface MigrateSource {
  /**
   * Begin a run. `dryRun` really means nothing is written to Gemini.
   *
   * `acknowledgeAclLoss` is the customer accepting that indexed knowledge loses
   * its source permissions; without it the server stops between extract and
   * insert and asks. It is a separate argument on purpose — it must be an act,
   * not a default.
   */
  start(session: string, opts: { dryRun: boolean; acknowledgeAclLoss?: boolean }): Promise<void>;
  /**
   * Attach to the run's event stream. Returns a detach.
   *
   * Attaching is now safe to do repeatedly: the server owns the run in a registry
   * and replays every event this subscriber missed before the live ones. It used
   * to BE the run, which is why re-opening it executed a second migration.
   */
  subscribe(session: string, onUpdate: (u: RunUpdate) => void): () => void;
  /**
   * Is a run live for this session right now?
   *
   * Distinguishes "nothing is happening" from "you missed the start" — coming back
   * to this screen, or reopening the tab entirely, must not offer to start a run
   * that is already going.
   */
  runState(session: string): Promise<RunState>;
  /**
   * Ask the run to stop. COOPERATIVE, not a cancel: the agent in flight finishes,
   * the rest stay staged, and the run ends as `stopped`. Never label this as
   * immediate — an agent mid-creation still completes.
   */
  stop(session: string): Promise<void>;
}

export interface RunState {
  phase: 'running' | 'stopping' | 'finished' | null;
  startedAt?: string;
  eventCount?: number;
  /** The server's buffer overflowed, so the earliest lines are no longer held. */
  truncated?: boolean;
  stopRequested?: boolean;
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
  /** What the verification actually saw. Absent on runs recorded before the
   *  evidence payload existed — absent is "we did not record it", not "clean". */
  evidence?: RunEvidence;
}

/** One past run, as listed. `verified + failed` need not equal `agents`: the
 *  difference is agents still owed a check, and folding those into either column
 *  would be a claim nobody has earned. */
export interface RunHistoryEntry {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  status: string;
  summary?: string;
  agents: number;
  verified: number;
  failed: number;
}

export interface ReportSource {
  /** The rows of one run — the latest if `runId` is omitted. */
  list(session: string, runId?: string): Promise<ReportRow[]>;
  /** Past runs for this tenant, newest first. Scoped server-side. */
  history(session: string): Promise<RunHistoryEntry[]>;
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
