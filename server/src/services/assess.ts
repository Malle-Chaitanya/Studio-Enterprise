import type { AgentIR } from '../types.js';
import { planKnowledgeMigration, type KnowledgeMigrationAction } from './knowledgePlanner.js';
import type { KnowledgeStrategy, GeminiTarget } from './knowledgeClassifier.js';
import { planTopicsMigration, type Capability } from './topicsMigration.js';

/**
 * Compatibility assessment: turns an extracted AgentIR into a read-only
 * component-by-component compatibility report for the Explore/Review screens.
 *
 * IMPORTANT: this is a HONEST, read-only preview — it reports what the engine
 * will actually do (supported / adapt / manual / none), including the things
 * v1 does NOT migrate (flows, connectors, RAG wiring). It never implies a
 * capability the migration engine doesn't have.
 */

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

/** Client-facing disposition of a knowledge source in the dry run. */
export type KnowledgeDisposition = 'auto' | 'reconnect' | 'manual';

export interface KnowledgeAction {
  /** Client-friendly title, e.g. "Documents (18 files)". */
  title: string;
  strategy: KnowledgeStrategy;
  target: GeminiTarget;
  disposition: KnowledgeDisposition;
  /** Website ownership verdict (owned / third-party / unknown), when applicable. */
  ownership?: string;
  /** Plain-English explanation shown under the title. */
  detail: string;
  /** Number of source files folded into this action (document target only). */
  fileCount?: number;
  /** Files that fail Gemini's format/size ingest gate (surfaced as warnings). */
  incompatibleFiles?: string[];
}

export interface KnowledgeAssessment {
  /** Raw knowledge-source count on the agent. */
  total: number;
  autoCount: number; // sources that migrate with no human setup
  reconnectCount: number; // sources reconnected via a native connector (needs federation)
  manualCount: number; // sources needing manual recreation/review
  actions: KnowledgeAction[];
}

export interface AgentAssessment {
  agent: string;
  sourceId: string;
  summary: Record<Compatibility, number>;
  effort: 'low' | 'medium' | 'high';
  components: ComponentAssessment[];
  dependencies: DependencyRef[];
  /** Knowledge-source dry run (added in the knowledge phase). */
  knowledge?: KnowledgeAssessment;
}

/** Map a compiled capability to a client-facing compatibility verdict (honest). */
function capabilityCompatibility(c: Capability): Compatibility {
  if (c.classification === 'system') return 'supported';
  // Side-effecting → can't be faithfully auto-run by a generative agent.
  if (c.classification === 'transactional' || c.determinism === 'requires-deterministic') return 'manual';
  if (c.fidelity === 'partial' || c.unresolvedState.length || c.classification === 'orchestration') return 'partial';
  return 'supported'; // clean Q&A, compiled into a followable procedure
}

/** Plain-English note for a capability in the assessment. */
function capabilityNote(c: Capability): string {
  const bits = [`${c.classification} capability`, `${c.provenance.nodeCount} step(s)`];
  if (c.triggers.length) bits.push(`${c.triggers.length} trigger(s)`);
  if (c.tools.length) bits.push(`${c.tools.length} tool(s)`);
  if (c.usesKnowledge) bits.push('uses knowledge');
  let note = bits.join(', ') + '.';
  if (c.determinism === 'requires-deterministic') note += ' Performs a real action → rebuild as a deterministic tool/workflow.';
  if (c.unresolvedState.length) note += ` Unresolved input(s): ${c.unresolvedState.join(', ')} (needs review).`;
  else if (c.classification !== 'system' && c.fidelity !== 'partial') note += ' Compiled into a followable procedure.';
  return note;
}

export function assessAgent(ir: AgentIR): AgentAssessment {
  const components: ComponentAssessment[] = [];
  const dependencies: DependencyRef[] = [];

  // ── System instructions ────────────────────────────────────────────────
  components.push(
    ir.instructions
      ? {
          component: 'System instructions',
          kind: 'instructions',
          compatibility: 'supported',
          note: 'Real agent instructions carried over verbatim.',
        }
      : {
          component: 'System instructions',
          kind: 'instructions',
          compatibility: 'manual',
          note: 'No explicit instructions in source; behavior derived from topics only — review recommended.',
        },
  );

  // ── Topics (compiled into capabilities — real classification, not guessed) ─
  const topicsPlan = planTopicsMigration(ir);
  const allCaps: Capability[] = [
    ...topicsPlan.systemCapabilities,
    ...topicsPlan.connectedAgents.flatMap((a) => a.capabilities),
  ];
  for (const c of allCaps) {
    components.push({
      component: `Topic: ${c.name}`,
      kind: c.classification === 'system' ? 'system-topic' : 'topic',
      compatibility: capabilityCompatibility(c),
      note: capabilityNote(c),
    });
    // Side-effecting tools + AI Builder become named dependencies for the report.
    for (const t of c.tools) {
      dependencies.push({
        type: t.kind === 'ai-builder' ? 'AI Builder Model' : t.requiresWorkflow ? 'Connector (needs Cloud Workflow)' : 'Connector',
        ref: t.ref,
        from: c.name,
      });
    }
  }

  // ── Knowledge sources (classified → plan-driven dry run) ─────────────────
  const knowledge = buildKnowledgeAssessment(ir);
  for (const action of knowledge.actions) {
    components.push({
      component: `Knowledge: ${action.title}`,
      kind: 'knowledge',
      compatibility:
        action.disposition === 'auto' ? 'supported' : action.disposition === 'reconnect' ? 'partial' : 'manual',
      note: action.detail,
    });
    // Non-automatic knowledge needs external wiring — surface it as a dependency.
    if (action.disposition !== 'auto') {
      dependencies.push({ type: `Knowledge (${action.strategy})`, ref: action.title, from: ir.name });
    }
  }

  // ── Capabilities ──────────────────────────────────────────────────────────
  if (ir.capabilities.webBrowsing) {
    components.push({
      component: 'Web browsing',
      kind: 'capability',
      compatibility: 'supported',
      note: 'Mapped to the Gemini googleSearch grounding tool.',
    });
  }
  if (ir.capabilities.codeInterpreter) {
    components.push({
      component: 'Code interpreter',
      kind: 'capability',
      compatibility: 'none',
      note: 'No equivalent in Gemini Enterprise agents (v1) — not carried over.',
    });
  }

  // ── Starter prompts ────────────────────────────────────────────────────
  if (ir.starterPrompts.length) {
    components.push({
      component: 'Starter prompts',
      kind: 'starters',
      compatibility: 'supported',
      note: `${ir.starterPrompts.length} conversation starter(s) carried over.`,
    });
  }

  const summary: Record<Compatibility, number> = { supported: 0, partial: 0, manual: 0, none: 0 };
  for (const c of components) summary[c.compatibility]++;

  // Effort: driven by how much manual/adaptation work remains.
  let effort: 'low' | 'medium' | 'high' = 'low';
  if (summary.manual >= 3 || summary.none >= 1) effort = 'high';
  else if (summary.manual >= 1 || summary.partial >= 3) effort = 'medium';

  return {
    agent: ir.name,
    sourceId: ir.sourceId,
    summary,
    effort,
    components,
    dependencies,
    knowledge,
  };
}

/** Disposition bucket for the client-facing dry run. */
function dispositionOf(a: KnowledgeMigrationAction): KnowledgeDisposition {
  if (a.automatable) return 'auto';
  if (a.strategy === 'reconnect') return 'reconnect';
  return 'manual';
}

/** Plain-English explanation of what will happen to a knowledge action. */
function detailOf(a: KnowledgeMigrationAction): string {
  switch (a.strategy) {
    case 'copy-and-index':
      return a.geminiTarget === 'document-data-store'
        ? `${a.files?.length ?? 0} file(s) uploaded to the agent's Knowledge (agentFiles) and indexed by Gemini.`
        : 'Objects transferred to Google Cloud Storage and imported — needs source credentials.';
    case 'recreate':
      if (a.ownership === 'owned') return `Own-domain website → create a website data store; verify domain ownership in Search Console to index it.`;
      if (a.ownership === 'third-party') return `Third-party website → rely on the agent's Google Search grounding (can't verify ownership to index).`;
      return `Website ownership undetermined → manual review recommended (you may own this domain, or it may be a partner site).`;
    case 'reconnect':
      return `Reconnected via Gemini's native connector — requires identity-federation setup for access control.`;
    case 'dataverse-snapshot':
      return 'Reference table exported to a Gemini structured data store (snapshot — refreshable; confirm no row-level-secured data).';
    case 'rebuild-as-tool':
      return 'Rebuilt as a Gemini agent tool — manual recreation of the connection required.';
    default:
      return 'No automatic path — manual review required. Raw configuration preserved.';
  }
}

/** Build the knowledge dry run from the classified sources' migration plan. */
export function buildKnowledgeAssessment(ir: AgentIR): KnowledgeAssessment {
  const plan = planKnowledgeMigration(ir.sourceId, ir.knowledgeSources);
  const actions: KnowledgeAction[] = plan.actions.map((a) => ({
    title: a.displayName,
    strategy: a.strategy,
    target: a.geminiTarget,
    disposition: dispositionOf(a),
    ownership: a.ownership,
    detail: detailOf(a),
    fileCount: a.files?.length,
    incompatibleFiles: a.files?.filter((f) => f.format && !/^(txt|json|md|pdf|html|htm|docx|pptx|xlsx|xlsm)$/.test(f.format)).map((f) => f.name ?? 'file'),
  }));

  let autoCount = 0;
  let reconnectCount = 0;
  let manualCount = 0;
  for (const a of plan.actions) {
    const n = a.sourceIds.length;
    const d = dispositionOf(a);
    if (d === 'auto') autoCount += n;
    else if (d === 'reconnect') reconnectCount += n;
    else manualCount += n;
  }

  return { total: ir.knowledgeSources.length, autoCount, reconnectCount, manualCount, actions };
}
