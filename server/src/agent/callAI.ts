import { config } from '../config.js';
import { logger } from '../logger.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export interface AiResult {
  content: string | null;
  tool_calls?: ToolCall[];
  model?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve LLM for the Studio Migrate chat agent.
 * Prefer the same credentials as GEM_CO (AZURE_OPENAI_*), then OpenAI, then
 * INSTRUCTION_LLM_* — one shared key, no separate AGENT_LLM required.
 */
function agentProvider(): { provider: string; apiKey: string; model: string; azureEndpoint?: string; azureDeployment?: string } | null {
  // 1) Same Azure OpenAI setup as GEM_CO
  if (process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_API_KEY) {
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AGENT_LLM_MODEL || 'gpt-4o';
    return {
      provider: 'azure',
      apiKey: process.env.AZURE_OPENAI_API_KEY,
      model: deployment,
      azureEndpoint: process.env.AZURE_OPENAI_ENDPOINT,
      azureDeployment: deployment,
    };
  }

  // 2) Explicit AGENT_LLM override (optional)
  const agentProviderName = (process.env.AGENT_LLM_PROVIDER || '').toLowerCase();
  const agentKey = process.env.AGENT_LLM_API_KEY || '';
  if (agentProviderName && agentKey) {
    return {
      provider: agentProviderName,
      apiKey: agentKey,
      model:
        process.env.AGENT_LLM_MODEL ||
        (agentProviderName === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini'),
    };
  }

  // 3) Shared OpenAI key
  if (process.env.OPENAI_API_KEY) {
    return {
      provider: 'openai',
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.AGENT_LLM_MODEL || 'gpt-4o-mini',
    };
  }

  // 4) Same INSTRUCTION_LLM_* key used by the mapper
  const instructionProvider = (config.INSTRUCTION_LLM_PROVIDER || '').toLowerCase();
  const instructionKey = config.INSTRUCTION_LLM_API_KEY || '';
  if (instructionProvider && instructionKey) {
    return {
      provider: instructionProvider,
      apiKey: instructionKey,
      model:
        config.INSTRUCTION_LLM_MODEL ||
        (instructionProvider === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini'),
    };
  }

  return null;
}

export function agentLlmConfigured(): boolean {
  return agentProvider() !== null;
}

/** Call the configured LLM with tools. Returns assistant message (+ optional tool_calls). */
export async function callAI(
  messages: ChatMessage[],
  tools: unknown[],
  opts?: { model?: string; maxTokens?: number },
): Promise<AiResult> {
  const cfg = agentProvider();
  if (!cfg) throw new Error('agent_llm_not_configured');

  if (cfg.provider === 'gemini') {
    return callGemini(messages, tools, cfg.apiKey, opts?.model || cfg.model, opts?.maxTokens ?? 2048);
  }
  if (cfg.provider === 'azure') {
    return callAzureOpenAI(messages, tools, cfg, opts?.maxTokens ?? 2048);
  }
  // openai / anthropic-as-openai-compatible
  if (cfg.provider === 'anthropic') {
    // Fall through: if only anthropic key for instructions, try OpenAI-compatible shim fails —
    // use a text-only gemini-style isn't available. Prefer openai if key looks usable.
    throw new Error('agent_llm_anthropic_tools_unsupported — set AGENT_LLM_PROVIDER=openai|azure|gemini');
  }
  return callOpenAI(messages, tools, cfg.apiKey, opts?.model || cfg.model, opts?.maxTokens ?? 2048);
}

async function callOpenAI(
  messages: ChatMessage[],
  tools: unknown[],
  apiKey: string,
  model: string,
  maxTokens: number,
): Promise<AiResult> {
  const body = {
    model,
    messages: messages.filter((m) => m && m.role),
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? 'auto' : undefined,
    max_tokens: maxTokens,
  };
  let lastErr = '';
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const json = (await res.json()) as {
        choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
        model?: string;
      };
      const msg = json.choices?.[0]?.message;
      return { content: msg?.content ?? null, tool_calls: msg?.tool_calls, model: json.model };
    }
    lastErr = await res.text();
    if (![429, 500, 502, 503, 504].includes(res.status) || attempt === 3) {
      throw new Error(`OpenAI error ${res.status}: ${lastErr.slice(0, 400)}`);
    }
    await sleep(1500 * 2 ** attempt);
  }
  throw new Error(`OpenAI error: ${lastErr}`);
}

async function callAzureOpenAI(
  messages: ChatMessage[],
  tools: unknown[],
  cfg: { apiKey: string; azureEndpoint?: string; azureDeployment?: string; model: string },
  maxTokens: number,
): Promise<AiResult> {
  const endpoint = (cfg.azureEndpoint || '').replace(/\/$/, '');
  const deployment = cfg.azureDeployment || cfg.model;
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=2024-06-01`;
  const body = {
    messages: messages.filter((m) => m && m.role),
    tools: tools.length ? tools : undefined,
    tool_choice: tools.length ? 'auto' : undefined,
    max_tokens: maxTokens,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'api-key': cfg.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Azure OpenAI error ${res.status}: ${t.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string | null; tool_calls?: ToolCall[] } }[];
    model?: string;
  };
  const msg = json.choices?.[0]?.message;
  return { content: msg?.content ?? null, tool_calls: msg?.tool_calls, model: json.model };
}

/** Gemini generateContent with functionDeclarations (OpenAI tool shape → Gemini). */
async function callGemini(
  messages: ChatMessage[],
  tools: unknown[],
  apiKey: string,
  model: string,
  maxTokens: number,
): Promise<AiResult> {
  const system = messages.find((m) => m.role === 'system')?.content ?? '';
  const contents: { role: string; parts: unknown[] }[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'tool') {
      contents.push({
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: m.name || 'tool',
              response: { result: m.content },
            },
          },
        ],
      });
      continue;
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      contents.push({
        role: 'model',
        parts: m.tool_calls.map((tc) => ({
          functionCall: {
            name: tc.function.name,
            args: safeParse(tc.function.arguments),
          },
        })),
      });
      if (m.content) contents.push({ role: 'model', parts: [{ text: m.content }] });
      continue;
    }
    contents.push({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content || '' }],
    });
  }

  const functionDeclarations = (tools as { function?: { name: string; description?: string; parameters?: unknown } }[])
    .map((t) => t.function)
    .filter(Boolean)
    .map((f) => ({
      name: f!.name,
      description: f!.description,
      parameters: f!.parameters,
    }));

  const body: Record<string, unknown> = {
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: { maxOutputTokens: maxTokens },
  };
  if (functionDeclarations.length) {
    body.tools = [{ functionDeclarations }];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Gemini error ${res.status}: ${t.slice(0, 400)}`);
  }
  const json = (await res.json()) as {
    candidates?: {
      content?: {
        parts?: {
          text?: string;
          functionCall?: { name?: string; args?: Record<string, unknown> };
        }[];
      };
    }[];
  };
  const parts = json.candidates?.[0]?.content?.parts ?? [];
  const textParts = parts.map((p) => p.text).filter(Boolean).join('');
  const tool_calls: ToolCall[] = parts
    .filter((p) => p.functionCall?.name)
    .map((p, i) => ({
      id: `gem_${Date.now()}_${i}`,
      type: 'function' as const,
      function: {
        name: p.functionCall!.name!,
        arguments: JSON.stringify(p.functionCall!.args ?? {}),
      },
    }));
  return {
    content: textParts || null,
    tool_calls: tool_calls.length ? tool_calls : undefined,
    model,
  };
}

function safeParse(s: string): Record<string, unknown> {
  try {
    return JSON.parse(s || '{}') as Record<string, unknown>;
  } catch {
    logger.warn('tool args parse failed');
    return {};
  }
}
