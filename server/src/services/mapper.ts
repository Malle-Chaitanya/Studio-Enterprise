import { config, llmEnabled } from '../config.js';
import { logger } from '../logger.js';
import { buildProceduresInstruction } from './topicsEmit.js';
import type { TopicsMigrationPlan } from './topicsMigration.js';
import type { AgentIR, FidelityNote, MappedAgent } from '../types.js';

/**
 * Maps an AgentIR to a Gemini Enterprise agent definition.
 *
 * The instruction is synthesized with fidelity in mind:
 *   1. The agent's REAL instructions lead (the biggest fidelity win vs. POC).
 *   2. When a topics plan is supplied, topics are COMPILED into followable
 *      "Conversation procedures" (via topicsEmit); otherwise they're summarized.
 *   3. System behaviors (fallback, escalate) are translated to guidance.
 * An optional LLM pass can polish the result; it is off by default and the
 * deterministic output is already high fidelity.
 */

const GEMINI_MODEL = 'gemini-2.5-flash';
// Gemini allows very large instructions (500k chars). Keep a generous cap so we
// can carry real AI Builder prompts without truncating the agent's brain.
const MAX_INSTRUCTION_CHARS = 60000;

function synthesizeInstruction(ir: AgentIR): { instruction: string; notes: FidelityNote[] } {
  const notes: FidelityNote[] = [];
  const custom = ir.topics.filter((t) => !t.isSystem);
  const aiTopics = ir.topics.filter((t) => t.aiPrompt);

  // ── INSTRUCTIONS ONLY ──────────────────────────────────────────────────────
  // The Gemini instruction is EXACTLY the source agent's instructions, verbatim.
  // We deliberately do NOT fold in AI Builder prompts, topic summaries,
  // capabilities, or synthesized boilerplate. Topic/AI-Builder logic is migrated
  // separately in the topics phase (built next) — it's captured in the IR/report
  // here, never injected into the instruction.
  let instruction = (ir.instructions ?? '').trim();

  if (instruction) {
    notes.push({ component: 'instructions', status: 'mapped', detail: 'Source instructions carried over verbatim (exact text — nothing added).' });
  } else {
    notes.push({
      component: 'instructions',
      status: 'needs-review',
      detail:
        'Source agent had no authored instructions — its logic lives in topics/AI Builder models, which are migrated in the topics phase (not folded into the instruction).',
    });
  }

  // Record (do NOT inject) the topic/AI-Builder logic so the report and the
  // upcoming topics phase know what still needs to be migrated.
  if (aiTopics.length) {
    notes.push({
      component: 'topics',
      status: 'needs-review',
      detail: `${aiTopics.length} topic AI Builder prompt(s) captured but NOT added to the instruction — to be migrated as topics next.`,
    });
  } else if (custom.length) {
    notes.push({
      component: 'topics',
      status: 'needs-review',
      detail: `${custom.length} custom topic(s) captured but NOT added to the instruction — to be migrated as topics next.`,
    });
  }

  // Web browsing still maps to the googleSearch tool (tool wiring, not text).
  if (ir.capabilities.webBrowsing) {
    notes.push({ component: 'webBrowsing', status: 'mapped', detail: 'Web browsing → googleSearch tool.' });
  }

  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    instruction = instruction.slice(0, MAX_INSTRUCTION_CHARS);
    notes.push({ component: 'instructions', status: 'partial', detail: `Instruction truncated to ${MAX_INSTRUCTION_CHARS} chars.` });
  }
  return { instruction, notes };
}

function buildStarterPrompts(ir: AgentIR): { text: string }[] {
  const prompts = ir.starterPrompts.length
    ? ir.starterPrompts
    : ['How can you help me?', 'What can you do?', 'Give me an overview'];
  return prompts.slice(0, 4).map((text) => ({ text }));
}

/** Optional LLM refinement of a synthesized instruction. Best-effort. */
async function refineWithLlm(instruction: string, ir: AgentIR): Promise<string> {
  if (!llmEnabled) return instruction;
  try {
    if (config.INSTRUCTION_LLM_PROVIDER === 'gemini') {
      const model = config.INSTRUCTION_LLM_MODEL || 'gemini-2.5-flash';
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${config.INSTRUCTION_LLM_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  {
                    text:
                      `Rewrite the following migrated agent system-instruction to be clear, well-structured, ` +
                      `and faithful to the original intent for the agent "${ir.name}". Keep all concrete rules. ` +
                      `Return only the instruction:\n\n${instruction}`,
                  },
                ],
              },
            ],
          }),
        },
      );
      if (res.ok) {
        const json = (await res.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text;
        if (text) return text.trim();
      }
    }
    // Anthropic and other providers can be added here behind the same flag.
  } catch (err) {
    logger.warn({ err, agent: ir.name }, 'LLM instruction refine failed; using deterministic output');
  }
  return instruction;
}

/**
 * How knowledge sources Gemini can't import are handled (customer choice).
 * Generalized beyond websites: applies to ANY unsupported source (websites
 * today; SharePoint/Dataverse/SQL/APIs as they're added) — the UI and rule are
 * the same, so new unsupported types need no redesign.
 */
export type UnsupportedKnowledgeHandling = 'skip' | 'appendix' | 'report-only';

export interface MapOptions {
  /**
   * What to do with knowledge sources that can't be imported into Gemini
   * Knowledge. Default 'report-only' — preserved in the IR + report but the
   * runtime instruction is untouched. 'appendix' opts IN to a clearly-separated
   * "Migrated Knowledge References" block; 'skip' omits them.
   */
  unsupportedKnowledgeHandling?: UnsupportedKnowledgeHandling;
  /**
   * Compiled topics plan (from `planTopicsMigration`). When provided, its
   * capabilities are folded into the instruction as a "## Conversation
   * procedures" section — turning parsed topics into behavior the single agent
   * actually follows, instead of a one-line summary. The orchestrator computes
   * the plan once and passes it here (and stages it), so it isn't recomputed.
   */
  topicsPlan?: TopicsMigrationPlan;
}

/**
 * Build a clearly-SEPARATED "Additional Knowledge References" appendix for
 * knowledge the original agent used but Gemini can't import — specifically
 * URL-backed sources (documentation websites) the migrated agent can still
 * consult via its Google Search grounding.
 *
 * Audience = the MODEL: this is AI-usable knowledge (name + URL + purpose +
 * a behavioral cue to prefer them), NOT migration audit. The *why-it-wasn't-
 * imported* detail belongs in the migration report (admin audience), never here
 * — audit text in the prompt is noise that degrades behavior. Returns '' when
 * there are no URL-backed references to preserve.
 */
export function buildKnowledgeReferencesAppendix(ir: AgentIR): string {
  const sources = ir.knowledgeSources.filter(
    (k) => k.kind !== 'FileUpload' && (k.references ?? [k.reference]).some((r) => r && /^https?:\/\//i.test(r)),
  );
  if (!sources.length) return '';
  const items = sources.map((k) => {
    const url = (k.references ?? []).find((r) => /^https?:\/\//i.test(r)) ?? k.reference!;
    const purpose = k.description?.replace(/\s+/g, ' ').trim();
    return purpose ? `- ${k.name} (${url}) — ${purpose}` : `- ${k.name} (${url})`;
  });
  return (
    '\n\n---\n## Additional Knowledge References\n' +
    'The original agent used the following documentation to answer user questions. ' +
    'Treat these as authoritative references and prefer information from them when ' +
    'answering related questions.\n\n' +
    items.join('\n')
  );
}

export async function mapAgent(ir: AgentIR, opts?: MapOptions): Promise<MappedAgent> {
  const { instruction, notes } = synthesizeInstruction(ir);
  let refined = await refineWithLlm(instruction, ir);

  const handling: UnsupportedKnowledgeHandling = opts?.unsupportedKnowledgeHandling ?? 'report-only';
  if (handling === 'appendix') {
    const appendix = buildKnowledgeReferencesAppendix(ir);
    if (appendix) {
      refined += appendix;
      notes.push({
        component: 'knowledge-appendix',
        status: 'partial',
        detail: 'Non-file knowledge sources appended to the instruction as a separated "Migrated Knowledge References" annotation (customer-selected).',
      });
    }
  }

  // ── Topics: fold compiled capabilities into followable procedures ──────────
  if (opts?.topicsPlan) {
    const procedures = buildProceduresInstruction(opts.topicsPlan);
    if (procedures) {
      refined += '\n\n---\n' + procedures;
      const s = opts.topicsPlan.summary;
      notes.push({
        component: 'topics',
        status: s.needsReview ? 'partial' : 'mapped',
        detail:
          `${s.capabilities} topic(s) compiled into conversation procedures ` +
          `(${s.byFidelity.full} full, ${s.byFidelity.high} high, ${s.byFidelity.partial} partial; ` +
          `${s.needsReview} need review, ${s.deterministicTools} deterministic tool(s) to rebuild).`,
      });
    }
  }

  // Final safety cap — Gemini accepts large instructions, but keep it bounded.
  const HARD_CAP = 200_000;
  if (refined.length > HARD_CAP) {
    refined = refined.slice(0, HARD_CAP);
    notes.push({ component: 'instructions', status: 'partial', detail: `Instruction truncated to ${HARD_CAP} chars (procedures + knowledge exceeded the cap).` });
  }

  const fidelityNotes = [...notes, ...ir.unmapped.map<FidelityNote>((d) => ({ component: 'v2-deferred', status: 'needs-review', detail: d }))];

  // Description: prefer the authored source description, migrated in full (cap =
  // Gemini's real field limit, so we never truncate). Gemini REQUIRES a
  // non-empty description (create 400s on empty), so when the source has none we
  // fall back to the agent's own name — a factual minimal value, never
  // fabricated behavior text — and flag it for review.
  const authored = (ir.description ?? '').trim();
  // "This is the {name} agent." — append "agent" ONLY when the name doesn't
  // already end in it, so we get "…Data Enrichment agent." but never
  // "…Sales Opportunity Agent agent.". Grammar-safe for every name.
  const nm = ir.name.trim();
  const placeholder = `This is the ${nm}${/agents?\s*$/i.test(nm) ? '' : ' agent'}.`;
  const description = (authored || placeholder).slice(0, 500_000);
  if (!authored) {
    fidelityNotes.push({
      component: 'description',
      status: 'needs-review',
      detail:
        'Source agent had no description. Gemini requires one, so a placeholder ("This is the <name>.") was used — edit it in Gemini if a real description is needed.',
    });
  }

  return {
    ir,
    displayName: ir.name,
    description,
    instruction: refined,
    starterPrompts: buildStarterPrompts(ir),
    model: GEMINI_MODEL,
    // v1: every agent gets googleSearch grounding. Mapping Copilot connector
    // actions to Gemini tools is deferred to v2.
    tools: [{ name: 'googleSearch' }],
    fidelityNotes,
  };
}
