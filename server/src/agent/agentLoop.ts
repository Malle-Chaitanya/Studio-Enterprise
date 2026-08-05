import { agentLlmConfigured, callAI, type ChatMessage } from './callAI.js';
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
}

/** Rule-based fallback when no LLM is configured — still drives key chips/tools. */
async function ruleBasedTurn(input: AgentChatInput, emit: SseEmit): Promise<void> {
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
    emit({ type: 'chips', chips: defaultChips(input.pathname) });
    emit({ type: 'done' });
    return;
  }

  const clientMap = (input.clientState?.userMap as Record<string, string>) || {};
  const agents = input.clientState?.agents ?? [];
  const agentCount = Array.isArray(agents)
    ? agents.reduce((n, u) => n + (u.botIds?.length ?? 0), 0)
    : 0;

  const system = buildSystemPrompt({
    step: input.step,
    pathname: input.pathname,
    msConnected: !!input.session.tenantId,
    googleConnected: !!input.session.gEmail,
    mappedUsers: Object.keys(clientMap).filter((k) => clientMap[k]).length,
    selectedAgents: agentCount,
    llmEnabled: true,
  });

  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...history.slice(-20).map(
      (h): ChatMessage => ({
        role: h.role === 'assistant' ? 'assistant' : 'user',
        content: h.content,
      }),
    ),
    { role: 'user', content: input.message },
  ];

  const ctx: ToolExecContext = {
    session: input.session,
    sessionId: input.sessionId,
    clientState: input.clientState,
    confirmed: false,
    emit: (ev) => emit({ type: 'ui_event', event: ev }),
  };

  let finalText = '';
  try {
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const result = await callAI(messages, AGENT_TOOLS);
      if (result.tool_calls?.length) {
        messages.push({
          role: 'assistant',
          content: result.content,
          tool_calls: result.tool_calls,
        });
        let paused = false;
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
            finalText = result.content || 'I need your confirmation before continuing.';
            break;
          }
        }
        if (paused) break;
        continue;
      }
      finalText = result.content || '';
      break;
    }
  } catch (e) {
    logger.warn(`agent loop failed: ${(e as Error).message}`);
    emit({ type: 'error', message: (e as Error).message });
    // Graceful degrade to rules
    await ruleBasedTurn(input, emit);
    return;
  }

  if (!finalText) finalText = 'Done.';
  emit({ type: 'message', text: finalText });
  const nextHist: HistoryMessage[] = [
    ...history,
    { role: 'user' as const, content: input.message },
    { role: 'assistant' as const, content: finalText },
  ].slice(-40);
  await saveHistory(appUserId, input.sessionId, nextHist);
  emit({ type: 'chips', chips: defaultChips(input.pathname) });
  emit({ type: 'done', text: finalText });
}
