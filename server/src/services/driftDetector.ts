import type { AgentIR } from '../types.js';

/**
 * A narrow, deliberately scoped snapshot of the fields that actually change
 * what a migrated agent does — captured at the moment of a confirmed
 * successful sync, so a later re-run can tell "the source genuinely changed"
 * apart from "nothing changed, this is just today's routine re-run."
 *
 * Deliberately EXCLUDES `sourceMetadata` (provenance/audit only, per AgentIR's
 * own comment — Dataverse bumps `modifiedOn` on any save, including no-op
 * edits, so including it would false-positive on every re-run) and `topics`
 * (as of the 2026-07-30/08-03 decisions, topic-compiled text is not folded
 * into the deployed instruction and connected agents are never created —
 * a topic-only change has no live Gemini-side artifact to redeploy for).
 */
export interface DriftSnapshot {
  /**
   * The source agent's display name. Optional so snapshots written before this
   * existed still load — an absent name compares equal to anything, so adding this
   * field cannot make every previously-migrated agent redeploy on its next run.
   *
   * Renaming the source used to be invisible: the snapshot carried no name, so
   * `detectDrift` reported "unchanged", the run skipped with `already exists`, and
   * the Gemini agent kept its original display name permanently. Confirmed live
   * 2026-08-13 — a Copilot agent renamed to "knowledge Nexus" was reported missing
   * by the customer while sitting in Gemini, ENABLED and healthy, still called "A".
   *
   * Idempotency keys on `sourceId` rather than display name precisely so a rename
   * can be pushed in place (`PATCH ?updateMask=displayName,...`). That path existed
   * and worked; nothing ever noticed the rename to trigger it.
   */
  name?: string;
  instructions: string;
  description: string;
  starterPrompts: string[];
  webBrowsing: boolean;
  codeInterpreter: boolean;
  /** Sorted `${kind}:${id}:${reference}` per knowledge source, order-insensitive. */
  knowledgeFingerprint: string[];
  /**
   * Connector ids wired into the deployment, sorted. Optional so snapshots written
   * before this existed still load — they compare as an empty set, so the first
   * re-run after configuring a connector correctly reports drift.
   */
  connectorIds?: string[];
}

function knowledgeFingerprint(ir: AgentIR): string[] {
  return ir.knowledgeSources
    .map((k) => `${k.kind}:${k.id}:${k.reference ?? k.references?.[0] ?? ''}`)
    .sort();
}

export function snapshotFrom(ir: AgentIR, connectorIds: string[] = []): DriftSnapshot {
  return {
    name: ir.name,
    instructions: ir.instructions,
    description: ir.description,
    starterPrompts: [...ir.starterPrompts].sort(),
    webBrowsing: Boolean(ir.capabilities?.webBrowsing),
    codeInterpreter: Boolean(ir.capabilities?.codeInterpreter),
    knowledgeFingerprint: knowledgeFingerprint(ir),
    connectorIds: [...connectorIds].sort(),
  };
}

export interface DriftResult {
  changed: boolean;
  /** Human-readable reasons, empty when unchanged. */
  reasons: string[];
}

/** Exact-string/array compare — no fuzzy normalization, so a real edit is never silently missed. */
export function detectDrift(prev: DriftSnapshot, ir: AgentIR, connectorIds: string[] = []): DriftResult {
  const next = snapshotFrom(ir, connectorIds);
  const reasons: string[] = [];

  // Drift is not only about the SOURCE agent. What we deploy also depends on which
  // connectors are configured, and that is a decision made in our UI, after the first
  // migration. Without this, configuring Jira and re-running skipped the agent as
  // "already exists" and there was no way to get the tool onto it short of editing the
  // Copilot agent to force a change (live 2026-08-07).
  if (JSON.stringify(prev.connectorIds ?? []) !== JSON.stringify(next.connectorIds ?? [])) {
    reasons.push('configured connectors changed');
  }

  // Only when the OLD snapshot actually recorded a name. Treating an absent name as
  // "" would make every pre-existing snapshot report a rename on its first re-run
  // after this shipped — a redeploy storm across every already-migrated agent.
  if (prev.name !== undefined && prev.name !== next.name) {
    reasons.push(`renamed ("${prev.name}" -> "${next.name}")`);
  }

  if (prev.instructions !== next.instructions) reasons.push('instructions changed');
  if (prev.description !== next.description) reasons.push('description changed');
  if (JSON.stringify(prev.starterPrompts) !== JSON.stringify(next.starterPrompts)) reasons.push('starter prompts changed');
  if (prev.webBrowsing !== next.webBrowsing) reasons.push('web browsing capability changed');
  if (prev.codeInterpreter !== next.codeInterpreter) reasons.push('code interpreter capability changed');
  if (JSON.stringify(prev.knowledgeFingerprint) !== JSON.stringify(next.knowledgeFingerprint)) {
    reasons.push('knowledge source set changed');
  }

  return { changed: reasons.length > 0, reasons };
}
