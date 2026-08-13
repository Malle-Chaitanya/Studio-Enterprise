import { agentLlmConfigured, callAI, callAIStream, type ChatMessage } from './callAI.js';
import { buildSystemPrompt } from './systemPrompt.js';
import { AGENT_TOOLS } from './tools.js';
import { executeTool, type ToolExecContext, type UiEvent } from './toolExecutor.js';
import { loadHistory, saveHistory, type HistoryMessage } from './history.js';
import type { Session } from '../sessionStore.js';
import { DEFAULT_APP_USER_ID } from '../sessionStore.js';
import { logger } from '../logger.js';

const MAX_ITERATIONS = 8;

export type SseEmit = (event: Record<string, unknown>) => void;

export interface AgentChatInput {
  sessionId: string;
  session: Session;
  message: string;
  step?: string;
  pathname?: string;
  confirmed?: boolean;
  confirmTool?: string;
  confirmArgs?: Record<string, unknown>;
  clientState?: ToolExecContext['clientState'];
  /** True when the client fired this turn automatically (navigation or a significant click), not from a typed/tapped message. */
  systemTrigger?: boolean;
  /** Short description of the in-page click that triggered this turn (e.g. "Included environment 'CF_MANAGE'") — distinct from a page navigation. */
  actionNote?: string;
}

/** Short, static per-step orientation used when there's no LLM to generate one. */
const STEP_BLURBS: Record<string, string> = {
  connect:
    'Connect your Microsoft (Copilot Studio) and Google (Gemini Enterprise) admin accounts — both are needed before you can pick environments or agents.',
  pair: 'Pick which connected Microsoft tenant pairs with which connected Google Gemini Enterprise project for this migration run.',
  'map-users':
    "Map each Copilot Studio user to their Gemini Enterprise account so ownership and sharing carry over. \"Auto-map users\" handles most matches instantly.",
  map: "Choose which Copilot Studio environments to migrate and map each to a target Gemini Enterprise project & app. You'll pick the agents next.",
  'select-data':
    'Select which agents to migrate from the chosen environments — everything is preserved losslessly, even fields Gemini doesn\'t map yet.',
  connectors:
    'Review every SharePoint/OneDrive knowledge connector that needs setup on the Gemini side, across all agents, in one list.',
  migrate: 'Run a dry run to preview the migration safely, or start a live migration to create and publish the agents in Gemini Enterprise.',
};

function orientBlurb(step?: string): string {
  return (step && STEP_BLURBS[step]) || "Here's this step of the migration wizard — ask me anything or use a suggestion chip below.";
}

/** Human title per WizardStepId — keeps the LLM from having to guess what a step id like "select-data" means. */
const STEP_TITLES: Record<string, string> = {
  connect: 'Connect Platforms',
  pair: 'Choose Migration Pair',
  'map-users': 'Map Users',
  map: 'Select & Map Environments',
  'select-data': 'Select Agents',
  connectors: 'Connectors needed',
  migrate: 'Review & run',
};

/** Rule-based fallback when no LLM is configured — still drives key chips/tools. */
async function ruleBasedTurn(input: AgentChatInput, emit: SseEmit): Promise<void> {
  if (input.systemTrigger) {
    // No LLM to react to a click with — refresh chips silently rather than
    // spam a bland "Got it" on every action.
    if (!input.actionNote) emit({ type: 'message', text: orientBlurb(input.step) });
    emit({ type: 'chips', chips: defaultChips(input.pathname) });
    emit({ type: 'done' });
    return;
  }

  const msg = (input.message || '').toLowerCase();
  const events: UiEvent[] = [];
  const ctx: ToolExecContext = {
    session: input.session,
    sessionId: input.sessionId,
    clientState: input.clientState,
    confirmed: !!input.confirmed,
    emit: (ev) => {
      events.push(ev);
      emit({ type: 'ui_event', event: ev });
    },
  };

  if (input.confirmed && input.confirmTool) {
    const r = await executeTool(
      input.confirmTool,
      JSON.stringify(input.confirmArgs ?? {}),
      { ...ctx, confirmed: true },
    );
    emit({ type: 'message', text: r.message });
    emit({ type: 'chips', chips: defaultChips(input.pathname) });
    emit({ type: 'done' });
    return;
  }

  let tool: string | null = null;
  let args: Record<string, unknown> = {};

  if (/auto-?map|auto map/.test(msg)) tool = 'auto_map_users';
  else if (/clear mapping/.test(msg)) tool = 'clear_mappings';
  else if (/dry run/.test(msg)) {
    tool = 'start_migration';
    args = { dryRun: true };
  } else if (/live migration|go live|start live/.test(msg)) {
    tool = 'start_migration';
    args = { dryRun: false };
  } else if (/map users|go to map users/.test(msg)) {
    tool = 'navigate_to_step';
    args = { step: 'map-users' };
  } else if (/environment|go to env|select & map|go to environments/.test(msg)) {
    tool = 'navigate_to_step';
    args = { step: 'map' };
  } else if (/select agent|go to select|select data/.test(msg)) {
    tool = 'navigate_to_step';
    args = { step: 'select-data' };
  } else if (/connector/.test(msg)) tool = 'show_connectors';
  else if (/continue to pair|go to pair/.test(msg)) {
    tool = 'navigate_to_step';
    args = { step: 'pair' };
  } else if (/continue to migrate|go to migrate/.test(msg)) {
    tool = 'navigate_to_step';
    args = { step: 'migrate' };
  } else if (/fidelity|why.*private|permission/.test(msg)) tool = 'explain_fidelity';
  else if (/status|where am i/.test(msg)) tool = 'get_migration_status';
  else if (/list env/.test(msg)) tool = 'list_environments';

  if (tool) {
    const r = await executeTool(tool, JSON.stringify(args), ctx);
    if (r.pause) {
      emit({
        type: 'message',
        text: 'I need your confirmation before continuing.',
      });
    } else {
      emit({ type: 'message', text: r.message });
    }
  } else {
    emit({
      type: 'message',
      text:
        'I can auto-map users, navigate steps, and start a dry run. ' +
        '(LLM is not configured — set AZURE_OPENAI_* (same as GEM_CO) or OPENAI_API_KEY / INSTRUCTION_LLM_* for full chat.) ' +
        'Try a suggestion chip below.',
    });
  }
  emit({ type: 'chips', chips: defaultChips(input.pathname) });
  emit({ type: 'done' });
}

function defaultChips(pathname?: string): string[] {
  if (!pathname) return ['Auto-map users', 'Go to environments', 'Start dry run'];
  if (pathname.includes('map-users')) return ['Auto-map users', 'Go to environments', 'Clear mappings'];
  if (pathname.includes('select-data')) return ['Go to migrate', 'Show connectors', 'Why is an agent private?'];
  if (pathname.includes('migrate')) return ['Start dry run', 'Start live migration', 'Explain fidelity'];
  if (pathname.includes('/map')) return ['List environments', 'Go to Select Agents', 'Show connectors'];
  return ['Continue to Map Users', 'Auto-map users', 'Start dry run'];
}

/**
 * Contextual quick-reply chips: a cheap LLM call reads the assistant's last
 * reply + current step and proposes 3 short next-step labels, so chips track
 * the actual conversation instead of just the URL. Falls back to the static
 * per-step defaults if the LLM is unavailable or returns something unusable.
 */
async function generateChips(input: AgentChatInput, lastReply: string): Promise<string[]> {
  const fallback = defaultChips(input.pathname);
  if (!agentLlmConfigured() || !lastReply.trim()) return fallback;
  try {
    const prompt: ChatMessage[] = [
      {
        role: 'system',
        content:
          'You suggest quick-reply chip labels for a Copilot Studio -> Gemini Enterprise migration assistant chat. ' +
          'Reply with ONLY a JSON array of exactly 3 short strings (max 5 words each) — no prose, no markdown fences.',
      },
      {
        role: 'user',
        content:
          `Current step: ${input.step ?? input.pathname ?? 'unknown'}\n` +
          `Assistant's last reply: ${lastReply.slice(0, 500)}\n` +
          'Suggest 3 short next-step chip labels the user is likely to want next.',
      },
    ];
    const result = await callAI(prompt, [], { maxTokens: 80 });
    const raw = (result.content || '').trim().replace(/^```(json)?\s*|\s*```$/g, '');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length && parsed.every((s) => typeof s === 'string' && s.trim())) {
      return parsed.slice(0, 3).map((s) => s.trim());
    }
  } catch (e) {
    logger.warn(`chip generation failed, using defaults: ${(e as Error).message}`);
  }
  return fallback;
}

/**
 * Run one agent turn, streaming SSE events via `emit`.
 */
export async function runAgentTurn(input: AgentChatInput, emit: SseEmit): Promise<void> {
  if (!agentLlmConfigured()) {
    await ruleBasedTurn(input, emit);
    return;
  }

  const appUserId = input.session.appUserId ?? DEFAULT_APP_USER_ID;
  const history = await loadHistory(appUserId, input.sessionId);

  if (input.confirmed && input.confirmTool) {
    const ctx: ToolExecContext = {
      session: input.session,
      sessionId: input.sessionId,
      clientState: input.clientState,
      confirmed: true,
      emit: (ev) => emit({ type: 'ui_event', event: ev }),
    };
    const r = await executeTool(input.confirmTool, JSON.stringify(input.confirmArgs ?? {}), ctx);
    emit({ type: 'message', text: r.message });
    history.push({ role: 'user', content: 'confirmed' });
    history.push({ role: 'assistant', content: r.message });
    await saveHistory(appUserId, input.sessionId, history);
    emit({ type: 'chips', chips: await generateChips(input, r.message) });
    emit({ type: 'done' });
    return;
  }

  const clientMap = (input.clientState?.userMap as Record<string, string>) || {};
  const environments = Array.isArray(input.clientState?.envs) ? input.clientState!.envs! : [];
  const agentSelections = Array.isArray(input.clientState?.agents) ? input.clientState!.agents! : [];

  const system = buildSystemPrompt({
    step: input.step,
    pathname: input.pathname,
    msConnected: !!input.session.tenantId,
    googleConnected: !!input.session.gEmail,
    environments,
    agentSelections,
    mappedUsersCount: Object.keys(clientMap).filter((k) => clientMap[k]).length,
    hasPlan: !!input.session.plan,
    llmEnabled: true,
  });

  // On an auto-fired trigger there's no typed question. The system prompt already
  // carries full current-state + panel context, so the model has everything it needs
  // to react specifically instead of falling back on a generic "Welcome to X" line —
  // that fallback was the actual, confirmed cause of every navigation producing the
  // same canned message (2026-08-13). Told explicitly NOT to default to that here.
  const effectiveMessage = input.systemTrigger
    ? input.actionNote
      ? `The user just did this in the UI (they didn't type anything): "${input.actionNote}". In ONE short ` +
        `sentence, acknowledge it and add the next useful thing only if it's genuinely non-obvious. Do NOT ` +
        `call any tools, don't ask a question back, and don't just repeat the action verbatim.`
      : `The user just navigated to the "${(input.step && STEP_TITLES[input.step]) || input.step || input.pathname || 'current'}" ` +
        `step — they didn't type anything. Look at the Current State block in the system prompt: if there's a ` +
        `blocker, name it and the one fastest fix in ONE short sentence. If there is NOT a blocker (e.g. they ` +
        `already have agents selected, or mappings already exist), acknowledge that specific state instead of ` +
        `describing the step generically — e.g. "3 agents ready to go — head to Connectors or straight to a dry run." ` +
        `Do NOT open with "Welcome to..." — vary this every time based on what's actually true right now. Max ` +
        `~20 words. Do NOT call any tools and don't ask a question back; the user can ask for specifics or tap a chip.`
    : input.message;

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...history.slice(-20).map(
      (h): ChatMessage => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content,
      }),
    ),
    { role: 'user', content: effectiveMessage },
  ];

  const ctx: ToolExecContext = {
    session: input.session,
    sessionId: input.sessionId,
    clientState: input.clientState,
    confirmed: false,
    emit: (ev) => emit({ type: 'ui_event', event: ev }),
  };

  let streamedText = '';
  const onDelta = (chunk: string) => {
    streamedText += chunk;
    emit({ type: 'delta', text: chunk });
  };

  let paused = false;
  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const result = await callAIStream(messages, AGENT_TOOLS, onDelta);
      if (result.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.tool_calls,
        });
        for (const tc of result.tool_calls) {
          const tr = await executeTool(tc.function.name, tc.function.arguments, ctx);
          messages.push({
            role: 'tool',
            tool_call_id: tc.id,
            name: tc.function.name,
            content: JSON.stringify({ ok: tr.ok, message: tr.message, data: tr.data }),
          });
          if (tr.pause) {
            paused = true;
            break;
          }
        }
        if (paused) break;
        continue;
      }
      break;
    }
  } catch (e) {
    logger.warn(`agent loop failed: ${(e as Error).message}`);
    emit({ type: 'error', message: (e as Error).message });
    // Graceful degrade to rules
    await ruleBasedTurn(input, emit);
    return;
  }

  if (paused && !streamedText) {
    const fallback = 'I need your confirmation before continuing.';
    streamedText = fallback;
    emit({ type: 'delta', text: fallback });
  }
  const finalText = streamedText || 'Done.';
  // Don't persist the synthetic navigation prompt/reply — it would pollute
  // conversation history with a message the user never actually sent.
  if (!input.systemTrigger) {
    const nextHist: HistoryMessage[] = [
      ...history,
      { role: 'user' as const, content: input.message },
      { role: 'assistant' as const, content: finalText },
    ].slice(-40);
    await saveHistory(appUserId, input.sessionId, nextHist);
  }
  emit({ type: 'chips', chips: await generateChips(input, finalText) });
  emit({ type: 'done', text: finalText });
}
