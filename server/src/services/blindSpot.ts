import { z } from 'zod';
import { logger } from '../logger.js';
import { callAI, agentLlmConfigured, type ChatMessage } from '../agent/callAI.js';
import type { AgentToolIR } from '../types.js';

/**
 * Find what the parsers MISSED, by reading the raw payload a second way.
 *
 * WHY. Our most expensive bug class is a parser written against one tenant's payload shape.
 * Ledger §1.23: a topic-embedded `InvokeConnectorAction` was not the shape the TaskDialog
 * parser expected, so five Dataverse agents bound ZERO operations — 45 → 71 once fixed,
 * +58% coverage from a blind spot found by hand, after it had already cost a customer.
 * `customConnectorInventory.ts` exists for the same class of failure.
 *
 * A regex knows one shape. An LLM reading the same payload identifies a tool from INTENT —
 * Copilot carries the author's own description verbatim ("This operation returns a list of
 * issues using JQL"), which survives any amount of structural drift. That is the one job
 * here it does better than code.
 *
 * WHAT IT IS NOT ALLOWED TO DO. It never supplies an identifier we bind on. Binding needs
 * `connectorId` + `operationId` byte-exact against the swagger, and a model that reads
 * intent perfectly may still emit `PerformUnboundAction` for
 * `PerformUnboundActionWithOrganization` — which binds nothing, or worse, binds the wrong
 * operation. Non-deterministic extraction would also destroy the reproducibility that made
 * §1.23 findable at all: a parser that misses a field misses it identically every run, and
 * that is the signal.
 *
 * So the LLM produces a LEAD. A human confirms it. The parser gets fixed — deterministically,
 * with a test. Nothing here changes a migration.
 */

// ── The schema the model is forced into (AC10) ──────────────────────────────
//
// Structured output via a tool call, not "please return JSON": the model cannot emit a
// different shape, and Zod rejects it at the boundary if the provider does anyway.

const LlmToolSchema = z.object({
  name: z.string().min(1),
  connectorHint: z.string().optional(),
  operationHint: z.string().optional(),
  description: z.string().optional(),
  /** The component name the model read this from — makes a lead checkable by hand. */
  foundIn: z.string().optional(),
  confidence: z.enum(['high', 'medium', 'low']),
});

const LlmExtractionSchema = z.object({
  tools: z.array(LlmToolSchema).max(200),
});

export type LlmTool = z.infer<typeof LlmToolSchema>;

const EXTRACTION_TOOL = {
  type: 'function',
  function: {
    name: 'report_tools',
    description: 'Report every external tool / API call this Copilot agent can make.',
    parameters: {
      type: 'object',
      properties: {
        tools: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'The tool name as authored.' },
              connectorHint: {
                type: 'string',
                description:
                  'Connector id if literally present in the payload (e.g. shared_jira). Omit rather than guess.',
              },
              operationHint: {
                type: 'string',
                description:
                  'Operation id if literally present (e.g. ListIssues). Copy exactly. Omit rather than guess.',
              },
              description: { type: 'string', description: "The author's description of what it does." },
              foundIn: { type: 'string', description: 'Name of the component this was read from.' },
              confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            },
            required: ['name', 'confidence'],
          },
        },
      },
      required: ['tools'],
    },
  },
};

const SYSTEM_PROMPT = `You read raw Microsoft Copilot Studio agent definitions from Dataverse and list every external tool or API call the agent can make.

A tool is anything reaching outside the agent: a connector action, an HTTP request, a custom connector call, a Power Automate flow invocation. Tools appear in many shapes across tenants and product versions — InvokeConnectorAction, TaskDialog, HttpRequestAction, embedded action nodes inside topics, and shapes not listed here. Judge by INTENT, not by matching a known structure.

A tool ACTS. It invokes an operation the author chose, with arguments. If the agent merely
SEARCHES a body of content to ground an answer, that is knowledge, not a tool.

NEVER report these — they are knowledge sources, and listing them buries the real findings:
- FederatedStructuredSearchSource, DataverseStructuredSearchSource, or any *SearchSource
- "Skill configuration ..." components
- SharePoint / OneDrive / Drive documents, PDFs, files, or URLs the agent can read
- Dataverse tables the agent searches for grounding
- topics, trigger phrases, variables, and adaptive-card definitions
- topic redirects and dialog navigation: BeginDialog, EndDialog, CancelAllDialogs,
  RepeatDialog, "Topic.<Name>", "<publisher>_<agent>.topic.<Name>". These move the
  conversation between the agent's OWN topics — they leave nothing and call nobody.
- built-in system actions the author did not configure: LogCustomTelemetryEvent,
  SignOutUser, and the sign-in / authentication nodes Copilot inserts automatically

The test: could this call FAIL because an external system was down, a credential expired,
or a permission was missing? If no, it is not a tool.

Report these — they are tools:
- InvokeConnectorAction / connector operations (an operationId against a connector)
- HttpRequestAction and custom-connector calls
- Power Automate flow invocations
- InvokeAIBuilderModelTaskAction (it calls out to a model with a chosen aiModelId)

Rules:
- COPY identifiers exactly when they are literally present. Never complete, correct, or invent one. If an operation id looks truncated, copy the truncated form.
- OMIT connectorHint/operationHint entirely rather than guess. An omitted field is useful; a wrong one is harmful.
- Set confidence honestly. "low" is the correct answer when you think something is a tool but cannot tell.
- Include tools embedded inside topic definitions, not only top-level tool components.
- ALWAYS set foundIn to the exact component name you read the tool from. It is how a human verifies your finding, and how the diff avoids double-reporting a tool the parser already named differently.`;

/**
 * Trim components to what identifies a tool, so a large agent still fits a context window.
 *
 * Truncation is per-component and generous rather than global: dropping whole components
 * would mean the model never sees them, and the diff would read that absence as "the parser
 * was right" — the exact wrong conclusion. Cutting each component's tail keeps every
 * component represented.
 */
function summariseComponents(components: unknown[], perComponentChars = 6000): string {
  return components
    .map((c, i) => {
      const row = (c ?? {}) as Record<string, unknown>;
      const name = String(row.name ?? `component-${i}`);
      const type = String(row.componenttype ?? '?');
      const body = String(row.data ?? row.content ?? '');
      const clipped =
        body.length > perComponentChars
          ? `${body.slice(0, perComponentChars)}…[${body.length - perComponentChars} more chars]`
          : body;
      return `--- component: ${name} (componenttype=${type})\n${clipped}`;
    })
    .join('\n\n');
}

export interface LlmExtractionResult {
  tools: LlmTool[];
  /** Set when extraction could not run or its output failed validation. */
  error?: string;
}

/**
 * Ask the model what tools are in this payload. Never throws — a failed lead-finder must
 * not fail the thing it is auditing.
 */
export async function llmExtractTools(
  components: unknown[],
  opts?: { model?: string },
): Promise<LlmExtractionResult> {
  if (!agentLlmConfigured()) return { tools: [], error: 'llm_not_configured' };
  if (!components.length) return { tools: [] };

  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Raw Copilot Studio components for one agent:\n\n${summariseComponents(components)}\n\nCall report_tools with every external tool you can identify.`,
    },
  ];

  try {
    const res = await callAI(messages, [EXTRACTION_TOOL], { model: opts?.model, maxTokens: 8192 });
    const call = res.tool_calls?.find((t) => t.function?.name === 'report_tools');
    if (!call) return { tools: [], error: 'model_did_not_call_tool' };

    // Validate at the boundary. A provider that ignores the schema fails closed here rather
    // than propagating a malformed lead into a report someone acts on.
    const parsed = LlmExtractionSchema.safeParse(JSON.parse(call.function.arguments));
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues.slice(0, 3) }, 'blindSpot: LLM output failed schema');
      return { tools: [], error: 'schema_validation_failed' };
    }
    return { tools: parsed.data.tools };
  } catch (err) {
    logger.warn({ err }, 'blindSpot: LLM extraction failed (non-fatal)');
    return { tools: [], error: (err as Error).message };
  }
}

// ── The diff: pure, deterministic, unit-tested ──────────────────────────────

export interface ToolDiff {
  /** Both agreed — highest confidence the parser is right. */
  both: Array<{ parser: AgentToolIR; llm: LlmTool }>;
  /** Parser saw it, model didn't. A prompt weakness, not a parser bug. */
  parserOnly: AgentToolIR[];
  /** Model saw it, parser didn't. **This is the blind-spot signal** — §1.23 lives here. */
  llmOnly: LlmTool[];
}

/**
 * Normalise for comparison only. Never used to build a call — this deliberately destroys
 * the exactness binding depends on, which is precisely why its output must never reach
 * `bindOperation`.
 */
function norm(s: string | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Exact evidence that two entries are the same tool. Tried for EVERY pair before any fuzzy
 * rule runs, because fuzzy matching is greedy and will otherwise steal a partner that an
 * exact match had a stronger claim to.
 */
function exactMatch(parser: AgentToolIR, llm: LlmTool): boolean {
  const pName = norm(parser.name);
  const pDisplay = norm(parser.displayName);
  const lName = norm(llm.name);
  if (lName && (lName === pName || lName === pDisplay)) return true;

  // An operation id present on both sides is the strongest signal there is — names are
  // authored freely, ids are not.
  if (parser.operationId && llm.operationHint && parser.operationId === llm.operationHint) return true;

  // Same component, different label: the parser names a tool after its component
  // ("Custom prompt 8/3/2026, 12:23:14 PM"), the model after the action it performs
  // ("InvokeAIBuilderModelAction"). Observed live 2026-08-19.
  const lFound = norm(llm.foundIn);
  if (lFound && (lFound === pName || lFound === pDisplay)) return true;

  return false;
}

/**
 * Fuzzy fallback: containment, to catch "Jira - Get list of issues" vs "Get list of issues".
 *
 * Deliberately second-pass only. Confluence exposes BOTH `GetPages` and `GetPagesBySpace`,
 * whose authored names are "Confluence - Get pages" and "Confluence - Get pages within a
 * space" — one contains the other. Run greedily in one pass, the shorter model entry stole
 * the longer parser tool, and the genuine pair was then reported as a blind spot on a tool
 * the parser had correctly extracted (observed live 2026-08-19, agent "Migrate Advisor").
 */
function fuzzyMatch(parser: AgentToolIR, llm: LlmTool): boolean {
  const pName = norm(parser.name);
  const lName = norm(llm.name);
  if (!pName || !lName || lName.length <= 4) return false;
  return pName.includes(lName) || lName.includes(pName);
}

/**
 * Diff what the parser produced against what the model saw.
 *
 * Two passes — every exact match claimed first, then containment over what is left — and
 * one-to-one throughout, so two similarly named source tools cannot collapse into a single
 * match and silently hide one of them.
 */
export function diffTools(parserTools: AgentToolIR[], llmTools: LlmTool[]): ToolDiff {
  const both: ToolDiff['both'] = [];
  const usedParser = new Set<number>();
  const usedLlm = new Set<number>();

  const claim = (predicate: (p: AgentToolIR, l: LlmTool) => boolean): void => {
    llmTools.forEach((llm, li) => {
      if (usedLlm.has(li)) return;
      const pi = parserTools.findIndex((p, i) => !usedParser.has(i) && predicate(p, llm));
      if (pi === -1) return;
      usedParser.add(pi);
      usedLlm.add(li);
      both.push({ parser: parserTools[pi], llm });
    });
  };

  claim(exactMatch);
  claim(fuzzyMatch);

  return {
    both,
    parserOnly: parserTools.filter((_, i) => !usedParser.has(i)),
    llmOnly: llmTools.filter((_, i) => !usedLlm.has(i)),
  };
}

/**
 * One line a human can act on.
 *
 * Says "review" rather than "the parser is broken": an `llmOnly` entry is a lead, and some
 * will be model noise. Overstating it would train the reader to ignore the report.
 */
export function summariseDiff(diff: ToolDiff): string {
  const suspects = diff.llmOnly.filter((t) => t.confidence !== 'low');
  if (!suspects.length) {
    return `no blind spots found (${diff.both.length} tool(s) confirmed by both readers)`;
  }
  return (
    `${suspects.length} possible parser blind spot(s) to review: ` +
    suspects.map((t) => `"${t.name}"${t.foundIn ? ` in ${t.foundIn}` : ''}`).join(', ')
  );
}
