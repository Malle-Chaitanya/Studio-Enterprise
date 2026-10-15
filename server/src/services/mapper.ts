import { config, llmEnabled } from '../config.js';
import { REGISTRY_BY_ID } from '../connectors/registry.js';
import { logger } from '../logger.js';
import type { ResolvedConnector } from './connectorToolBuilder.js';
import { connectorCapabilityRefs, buildLiveConnectorInstruction } from './connectorToolBuilder.js';
import { translateFlow, integrationNameForFlow } from './flowMapper.js';
import type { AgentIR, AgentToolIR, FidelityNote, MappedAgent, MappedFlowIntegration } from '../types.js';

/**
 * Maps an AgentIR to a Gemini Enterprise agent definition.
 *
 * The instruction is synthesized with fidelity in mind: the agent's REAL
 * instructions lead, verbatim — and that's ALL that goes into the instruction
 * text. Nothing else is folded in. Topics are migrated separately, as ADK
 * sub-agents inside the same Reasoning Engine (see orchestrator.ts's
 * topicSubAgents) — not folded into this instruction text; this module only
 * records that fact as a fidelity note.
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
      detail:
        `${aiTopics.length} topic AI Builder prompt(s) kept out of the instruction (deliberately — mixing them ` +
        'with author-written instructions shifts the agent tone). Each topic is deployed as an ADK ' +
        'sub-agent carrying its own prompt, inside the same Reasoning Engine. Review that the routing ' +
        'descriptions send the right requests to each one.',
    });
  } else if (custom.length) {
    notes.push({
      component: 'topics',
      status: 'needs-review',
      detail:
        `${custom.length} custom topic(s) deployed as ADK sub-agents inside the same Reasoning Engine ` +
        '(one engine, not one per topic), rather than folded into the instruction text. The root agent ' +
        'routes to them by description — verify the routing matches how the source agent behaved.',
    });
  }

  // WHOSE credentials each tool runs under. Copilot's `invoker` mode means the tool used the
  // SIGNED-IN USER's own connection — Erik's mail sent as Erik, Erik's CRM query returning
  // only Erik's records. Every tool we deploy authenticates with ONE stored credential, so an
  // invoker tool silently becomes shared: mail leaves from one mailbox for everybody, and
  // every user sees whatever that one connection can see.
  //
  // It cannot be caught by testing — the tool works, it just answers for the wrong person —
  // so the ONLY thing standing between the customer and finding out from their own users is
  // this note. `connectionAuthMode` has been extracted since the connector work landed and
  // nothing read it; a report that stayed silent here was claiming a fidelity we do not have.
  // PER-USER TOOLS. Copilot `invoker` ran the tool as whoever was asking. These are deployed
  // to run as the caller too — never on the shared credential — so the note's job is to say
  // what each person must still do, and to be explicit where that is impossible.
  //
  // Split by whether the connector actually HAS a delegated sign-in, because the two are
  // different facts with different remedies: one is a setup step, the other is a permanent
  // limit. Reporting both as "needs review" would hide which is which.
  // CONNECTOR tools only. `connectionAuthMode` is recorded on every tool Copilot ran under
  // a connection, FLOW-backed and built-in tools included, and those carry no connectorId at
  // all - so they failed both the `impersonated` and `delegable` tests below (each of which
  // requires one) and fell into `blocked`, reported as "their connector offers no per-user
  // sign-in". They have no connector to be short of. Measured live 2026-10-14: four flow
  // tools on Credit Amendment Agent were called lost while GetRateSheetBand answered in the
  // deployed agent, returning a real rate. A flow's own fidelity notes cover it properly.
  const invokerTools = (ir.agentTools ?? []).filter(
    (t) => t.connectionAuthMode === 'invoker' && t.connectorId,
  );
  if (invokerTools.length) {
    const label = (t: { displayName?: string; name?: string }) => t.displayName || t.name;
    // Three outcomes, three different things to tell the customer: nothing to do, one setup
    // step per person, or a permanent limit. Collapsing them would either invent work that
    // is not needed or imply a fix that does not exist.
    const impersonated = invokerTools.filter(
      (t) => t.connectorId && REGISTRY_BY_ID.get(t.connectorId)?.impersonation,
    );
    const delegable = invokerTools.filter(
      (t) => !impersonated.includes(t) && t.connectorId && REGISTRY_BY_ID.get(t.connectorId)?.userAuth,
    );
    const blocked = invokerTools.filter((t) => !impersonated.includes(t) && !delegable.includes(t));

    if (impersonated.length) {
      notes.push({
        component: 'toolCredentials',
        status: 'mapped',
        detail:
          `${impersonated.length} tool(s) ran under each END USER's own connection in Copilot `
          + `(${impersonated.map(label).join(', ')}) and still do: each call names the person `
          + 'asking and the platform applies their own permissions. Nobody has to connect an '
          + 'account, and nothing expires.',
      });
    }

    if (delegable.length) {
      notes.push({
        component: 'toolCredentials',
        status: 'needs-review',
        detail:
          `${delegable.length} tool(s) ran under each END USER's own connection in Copilot ` +
          `(${delegable.map(label).join(', ')}) and are deployed the same way. Each person must ` +
          'connect their own account once before these tools work for them; until they do, the ' +
          'tool refuses rather than falling back to a shared account.',
      });
    }
    if (blocked.length) {
      notes.push({
        component: 'toolCredentials',
        status: 'lost',
        detail:
          `${blocked.length} tool(s) ran under each END USER's own connection in Copilot ` +
          `(${blocked.map(label).join(', ')}), and their connector offers no per-user sign-in, ` +
          'so that cannot be reproduced. These tools refuse for everyone rather than acting as ' +
          "one shared account — which would silently give every user another person's access.",
      });
    }
  }

  // Web browsing still maps to the googleSearch tool (tool wiring, not text).
  if (ir.capabilities.webBrowsing) {
    notes.push({ component: 'webBrowsing', status: 'mapped', detail: 'Web browsing → googleSearch tool.' });
  }

  // FIELD-LEVEL guidance the author attached to one INPUT of one bound tool — a fixed
  // value to always send (a pinned Subject line), or a description telling the model
  // where a "model"-filled value comes from (Copilot shows this to its own orchestrator
  // the moment it is about to fill that field, e.g. "use GetClientProfile's Email field,
  // never ask"). The migrated tool is one GENERIC implementation shared across every
  // customer and every agent on this connector, so it carries none of this — only the
  // instruction can. The IR already captures it losslessly (`AgentToolIR.inputs`);
  // synthesizeInstruction just never read it until 2026-10-14.
  //
  // ⚠️ INTERIM MEASURE, SHIPPED UNDER TIME PRESSURE 2026-10-15 — NOT THE REAL FIX, DO NOT
  // treat this block as closing the gap generally. It splices each tool's guidance next to
  // that tool's own mention in the author's instruction prose when it can find one (so the
  // model sees "use GetClientProfile's Email field, never ask" right next to "Do not call
  // SendEmail until approved", not 2000 characters later in an undifferentiated tail list).
  // That matching is HEURISTIC and AUTHOR-STYLE-DEPENDENT: it works here because this
  // agent's instructions happen to name each step in prose with a token that also appears
  // on the tool (`displayName`, or `operationId` with its version suffix stripped, for
  // "SendEmail" ~ "SendEmailV2"). A differently-worded instruction, or one that never
  // enumerates steps in prose, gets NO benefit — it silently falls back to the old tail-list
  // placement below. The real, generalizable fix is per-agent tool-wrapper generation at
  // DEPLOY time (bake `fixed` inputs into the tool so the model is never asked about them at
  // all, and override `model` inputs' docstrings with THIS agent's own sourcing guidance) —
  // that needs an architect pass and is tracked separately, not shipped here.
  const toolGuidanceLines = new Map<AgentToolIR, string[]>();
  let guidanceCount = 0;
  for (const tool of ir.agentTools ?? []) {
    const lines: string[] = [];
    for (const input of tool.inputs ?? []) {
      if (input.source === 'fixed' && input.value && !input.isExpression) {
        lines.push(`  → **${input.name}**: always use exactly "${input.value}".`);
      } else if (input.source === 'model') {
        // `scalar()` (services/toolPayload.ts) leaves a bare YAML block-scalar indicator
        // ("|", "|+") when the author's block had no real content — not guidance to repeat.
        const desc = input.description?.trim();
        if (desc && !/^\|[+-]?$/.test(desc)) {
          lines.push(`  → **${input.name}**: ${desc}`);
        }
      }
    }
    if (lines.length) {
      toolGuidanceLines.set(tool, lines);
      guidanceCount += lines.length;
    }
  }

  const tailFallback: string[] = [];
  let inlineMatched = 0;
  for (const [tool, lines] of toolGuidanceLines) {
    const label = tool.displayName || tool.name;
    // Version-suffix-stripped operationId last, so "SendEmailV2" also matches a prose
    // mention of plain "SendEmail" — the shorthand an author's own instructions commonly use.
    const candidates = [tool.displayName?.trim(), tool.name, tool.operationId, tool.operationId?.replace(/V\d+$/i, '')]
      .filter((c): c is string => !!c && c.length > 2);
    const matchIdx = candidates.map((c) => instruction.indexOf(c)).find((i) => i >= 0);
    if (matchIdx !== undefined) {
      const lineEnd = instruction.indexOf('\n', matchIdx);
      const insertAt = lineEnd === -1 ? instruction.length : lineEnd;
      instruction = `${instruction.slice(0, insertAt)}\n${lines.join('\n')}${instruction.slice(insertAt)}`;
      inlineMatched += 1;
    } else {
      tailFallback.push(`- **${label}**:\n${lines.join('\n')}`);
    }
  }
  if (tailFallback.length) {
    instruction += `\n\n## Field-level guidance from the source agent\n${tailFallback.join('\n')}`;
  }
  if (guidanceCount) {
    notes.push({
      component: 'instructions',
      status: 'mapped',
      detail:
        `${guidanceCount} tool-input-level rule(s) from the source agent folded into the instruction ` +
        '(fixed values and model-fill sourcing guidance that the generic migrated tool cannot carry on its own) — ' +
        `${inlineMatched}/${toolGuidanceLines.size} tool(s) matched inline next to their mention in the author's ` +
        'own instruction, the rest placed in a tail summary.',
    });
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

export interface MapOptions {
  /**
   * Resolved third-party / MS-native connector contexts. When provided, a
   * structured `## External Connector Access` block is appended to the agent
   * instruction so the Gemini agent knows the base URLs, auth headers, and
   * usage pattern for each configured connector.
   */
  connectors?: ResolvedConnector[];
  /**
   * Customer-chosen destination display name (db/repos/agentDestinationName.ts),
   * overriding `ir.name`. Absent means "use the source name" — unset for every
   * agent nobody renamed, so this changes nothing by default.
   */
  destinationName?: string;
}

export async function mapAgent(ir: AgentIR, opts?: MapOptions): Promise<MappedAgent> {
  const { instruction, notes } = synthesizeInstruction(ir);
  let refined = await refineWithLlm(instruction, ir);

  // ── Connector instruction block ────────────────────────────────────────────
  // Credential-free on purpose. The old block pasted each connector's base URL and
  // bearer token into the instruction, which (a) gave the model no actual ability to
  // call anything and (b) let any user extract the token by asking the agent to
  // repeat its prompt. Real calling ability comes from ADK function tools wired at
  // deploy time (AdkSpec.liveConnectors); this text only tells the agent when to
  // reach for them.
  if (opts?.connectors && opts.connectors.length > 0) {
    // Identity only: this path writes instruction text and must not construct secret ids.
    const specs = connectorCapabilityRefs(opts.connectors.map((c) => c.connectorId));
    const block = buildLiveConnectorInstruction(specs);
    if (block) {
      refined += block;
      notes.push({
        component: 'connectors',
        status: 'needs-review',
        detail:
          `${specs.length} external connector(s) wired as live API tools: ${specs.map((c) => c.name).join(', ')}. ` +
          'Credentials stay in Secret Manager and are read per call — never placed in the agent instruction. ' +
          'This migrates API ACCESS to these systems, not the source flow\'s orchestration logic ' +
          '(triggers, conditions, loops): the agent decides which calls to make, so verify the ' +
          'behaviour matches what the Copilot flow did before relying on it.',
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

  // Agent Flows: translate each one (pure, offline — see flowMapper.ts) and merge its
  // fidelity notes into the agent's overall report, exactly like every other capability
  // here. Creation in Google happens separately, in Phase 2 (services/applicationIntegration.ts) —
  // this only produces what that phase needs, staged alongside the rest of `mapped`.
  let flowIntegrations: MappedFlowIntegration[] | undefined;
  if (ir.flows?.length) {
    flowIntegrations = ir.flows.map((flow) => translateFlow(flow, { integrationName: integrationNameForFlow(flow.name) }));
    for (const f of flowIntegrations) fidelityNotes.push(...f.fidelityNotes);
  }

  return {
    ir,
    displayName: opts?.destinationName || ir.name,
    description,
    instruction: refined,
    starterPrompts: buildStarterPrompts(ir),
    model: GEMINI_MODEL,
    // googleSearch grounding mirrors the source's actual webBrowsing capability
    // (see the fidelity note above, pushed under the same condition) — a
    // source agent without web browsing must not gain it just by migrating.
    // Copilot connector actions map to real ADK function tools instead, wired at
    // deploy time via AdkSpec.liveConnectors (see connectorToolBuilder).
    tools: ir.capabilities?.webBrowsing ? [{ name: 'googleSearch' }] : [],
    fidelityNotes,
    flowIntegrations,
  };
}
