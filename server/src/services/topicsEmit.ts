/**
 * Topics EMIT (stage 7, artifact side) — turn a TopicsMigrationPlan into the
 * concrete destination shapes, WITHOUT deploying.
 *
 * Two products, matching the two-speed reality of the destination API:
 *
 *   1. buildProceduresInstruction(plan)
 *      A markdown "## Conversation procedures" section that folds the compiled
 *      capabilities into a SINGLE agent's instruction. Deployable TODAY through
 *      the proven single-agent `lowCodeAgentDefinition` create path — this is the
 *      immediate fidelity win over "topic summarized as a capability".
 *
 *   2. buildConnectedAgentArtifact(plan)
 *      The full Topic→Capability→Connected-Agent destination artifact (root +
 *      domain sub-agents + tools + required Cloud Workflows). This is the
 *      dry-run PREVIEW / future-deploy plan. The multi-node connected-agent wire
 *      format on the Gemini side still drifts, so we EMIT the artifact (shown in
 *      the report, stored) but do not fabricate a deploy call for it here.
 *
 * PURE: no I/O, no LLM. Deterministic; unit-testable (_test_topics_emit.ts).
 */
import type { TopicsMigrationPlan, Capability, ConnectedAgentPlan } from './topicsMigration.js';

const MAX_TRIGGERS_SHOWN = 6;

/** Render one capability as a numbered, followable procedure block. */
export function renderCapability(cap: Capability): string {
  const parts: string[] = [];
  parts.push(`### ${cap.name}`);

  const triggers = cap.triggers.slice(0, MAX_TRIGGERS_SHOWN).map((t) => `"${t}"`);
  if (triggers.length) {
    parts.push(`When the user says things like ${triggers.join(', ')}, follow these steps:`);
  } else {
    parts.push('When this topic applies, follow these steps:');
  }

  parts.push(cap.procedure || '- (No explicit steps — respond helpfully using the description above.)');

  if (cap.stateIn.length) parts.push(`_Inputs needed: ${cap.stateIn.join(', ')}._`);
  if (cap.usesKnowledge) parts.push('_Use the connected knowledge sources when answering._');
  if (cap.unresolvedState.length) {
    parts.push(`> ⚠ Needs review — these inputs are used but never set here: ${cap.unresolvedState.join(', ')}.`);
  }
  if (cap.determinism === 'requires-deterministic') {
    parts.push('> ⚠ This capability performs a real action; it must run as a deterministic tool/workflow, not by model discretion.');
  }
  return parts.join('\n\n');
}

/** Root-agent behavioral guidance derived from the system capabilities. */
export function buildRootGuidance(plan: TopicsMigrationPlan): string {
  const names = new Set(plan.systemCapabilities.map((c) => c.name.toLowerCase()));
  const lines: string[] = [];
  const has = (kw: string) => [...names].some((n) => n.includes(kw));
  if (has('fallback') || has('unknown')) lines.push('If a request is unclear or out of scope, ask a clarifying question rather than guessing.');
  if (has('escalate')) lines.push('If the user needs a human, offer to escalate to a human agent.');
  if (has('greeting') || has('start') || has('conversation')) lines.push('Greet the user warmly and briefly state how you can help.');
  if (has('start over') || has('restart')) lines.push('If the user asks to start over, confirm, then reset the conversation.');

  const domains = [...new Set(plan.connectedAgents.map((a) => a.domain))].filter(Boolean);
  if (domains.length > 1) {
    lines.push(`Route each request to the most relevant area: ${domains.join(', ')}.`);
  }
  if (!lines.length) return '';
  return '## Conversation guidance\n' + lines.map((l) => `- ${l}`).join('\n');
}

/**
 * Fold ALL business capabilities into a single "## Conversation procedures"
 * section. Deployable now via the single-agent create path.
 */
export function buildProceduresInstruction(plan: TopicsMigrationPlan): string {
  const caps = plan.connectedAgents.flatMap((a) => a.capabilities);
  if (!caps.length && !plan.systemCapabilities.length) return '';

  const blocks: string[] = [];
  const guidance = buildRootGuidance(plan);
  if (guidance) blocks.push(guidance);

  if (caps.length) {
    blocks.push('## Conversation procedures\nHandle the following requests by following each procedure exactly.');
    for (const cap of caps) blocks.push(renderCapability(cap));
  }
  return blocks.join('\n\n');
}

// ── Full connected-agent artifact (dry-run preview / future deploy) ──────────

export interface WorkflowRequirement {
  ref: string;
  kind: 'connector' | 'http';
  /** The capability that needs it — provenance. */
  capabilityId: string;
}

export interface EmittedConnectedAgent {
  id: string; // stable id derived from domain (for wiring subAgentIds)
  displayName: string;
  domain: string;
  instruction: string;
  tools: { name: string }[];
  starterPrompts: { text: string }[];
  workflowsRequired: WorkflowRequirement[];
  capabilityIds: string[];
}

export interface TopicsArtifact {
  /** Root-agent guidance + routing (system topics), no LLM. */
  rootInstruction: string;
  connectedAgents: EmittedConnectedAgent[];
  summary: {
    connectedAgents: number;
    capabilities: number;
    workflowsRequired: number;
    needsReview: number;
  };
}

/** Slugify a domain into a stable node id. */
function domainId(domain: string, i: number): string {
  const slug = domain.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `ca_${slug || 'domain'}_${i}`;
}

function buildConnectedAgentInstruction(ca: ConnectedAgentPlan): string {
  const blocks: string[] = [];
  blocks.push(`You handle ${ca.domain} requests. Follow each procedure exactly.`);
  for (const cap of ca.capabilities) blocks.push(renderCapability(cap));
  return blocks.join('\n\n');
}

/**
 * Build the full destination artifact. This is data for the dry-run report and
 * the future connected-agent deployer — it does NOT call any Google API.
 */
export function buildConnectedAgentArtifact(plan: TopicsMigrationPlan): TopicsArtifact {
  let needsReview = 0;
  let workflowsRequired = 0;

  const connectedAgents: EmittedConnectedAgent[] = plan.connectedAgents.map((ca, i) => {
    const workflows: WorkflowRequirement[] = [];
    for (const cap of ca.capabilities) {
      if (cap.needsHumanReview) needsReview++;
      for (const t of cap.tools) {
        if (t.requiresWorkflow && (t.kind === 'connector' || t.kind === 'http')) {
          workflows.push({ ref: t.ref, kind: t.kind, capabilityId: cap.id });
        }
      }
    }
    workflowsRequired += workflows.length;

    // Every agent gets googleSearch grounding; knowledge-using groups keep it too.
    const tools = [{ name: 'googleSearch' }];

    return {
      id: domainId(ca.domain, i),
      displayName: ca.name,
      domain: ca.domain,
      instruction: buildConnectedAgentInstruction(ca),
      tools,
      starterPrompts: ca.starterPrompts.slice(0, 4).map((text) => ({ text })),
      workflowsRequired: workflows,
      capabilityIds: ca.capabilities.map((c) => c.id),
    };
  });

  return {
    rootInstruction: buildRootGuidance(plan),
    connectedAgents,
    summary: {
      connectedAgents: connectedAgents.length,
      capabilities: plan.summary.capabilities,
      workflowsRequired,
      needsReview,
    },
  };
}
