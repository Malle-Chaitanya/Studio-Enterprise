/**
 * Chat with a migrated ADK agent (Vertex AI Reasoning Engine / Agent Engine).
 *
 * This is the invocation contract the migration reports as "working", so it must
 * match what the platform actually accepts. Discovered live (2026-08-06):
 *
 *   - ADK deployments expose NO `query` method. Depending on how the Python SDK
 *     packaged them they advertise either
 *       framework=google-adk: create_session, get_session, ..., stream_query,
 *                             async_stream_query, streaming_agent_run_with_events
 *       framework=custom:     query, stream_query, async_stream_query
 *     Calling `class_method='query'` on the first shape is what produced the
 *     long-standing "400 Reasoning Engine Execution failed" that was mistaken
 *     for a Google platform bug.
 *   - `stream_query` ALWAYS requires `user_id`. Omitting it fails the same way
 *     ("AdkApp.stream_query() missing 1 required keyword-only argument: 'user_id'"),
 *     which is why a bare call looked like a container failure too.
 *   - `session_id` is optional: AdkApp creates a session when none is passed. We
 *     still create one when the engine advertises create_session, so multi-turn
 *     conversations keep their history.
 *
 * Response is SSE-ish: a stream of ADK event JSON objects. We concatenate the
 * model text parts, which is all the caller needs to render a reply.
 */

import { logger } from '../logger.js';

const DEFAULT_LOCATION = process.env.ADK_LOCATION || 'us-central1';

function aiHost(location: string): string {
  return `https://${location}-aiplatform.googleapis.com/v1beta1`;
}

function engineUrl(project: string, location: string, reasoningEngineId: string): string {
  return `${aiHost(location)}/projects/${project}/locations/${location}/reasoningEngines/${reasoningEngineId}`;
}

/** Pull the model's text out of a stream of ADK event objects. */
function extractText(raw: string): string {
  return [...raw.matchAll(/"text":\s*"((?:[^"\\]|\\.)*)"/g)]
    .map((m) => {
      try {
        return JSON.parse(`"${m[1]}"`) as string;
      } catch {
        return m[1];
      }
    })
    .join('')
    .trim();
}

/** Best-effort detail extraction — Agent Engine buries the real cause in `detail`. */
function errorDetail(raw: string): string {
  const detail = /"detail":\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1];
  if (detail) {
    try {
      return JSON.parse(`"${detail}"`) as string;
    } catch {
      return detail;
    }
  }
  return raw.replace(/\s+/g, ' ').slice(0, 300);
}

export interface AdkChatResult {
  ok: boolean;
  answer?: string;
  sessionId?: string;
  /** True when the agent's VertexAiSearchTool was invoked for this turn. */
  usedSearchTool?: boolean;
  error?: string;
}

/** Which class methods does this deployment expose? */
export async function getReasoningEngineMethods(
  project: string,
  saToken: string,
  reasoningEngineId: string,
  location = DEFAULT_LOCATION,
): Promise<{ methods: string[]; framework?: string; displayName?: string } | null> {
  const res = await fetch(engineUrl(project, location, reasoningEngineId), {
    headers: { Authorization: `Bearer ${saToken}` },
  });
  if (!res.ok) return null;
  const json = (await res.json()) as {
    displayName?: string;
    spec?: { agentFramework?: string; classMethods?: Array<{ name?: string }> };
  };
  return {
    methods: (json.spec?.classMethods ?? []).map((m) => m.name ?? '').filter(Boolean),
    framework: json.spec?.agentFramework,
    displayName: json.displayName,
  };
}

/** Open a session so a multi-turn conversation keeps history. Not all deployments support it. */
export async function createAdkSession(
  project: string,
  saToken: string,
  reasoningEngineId: string,
  userId: string,
  location = DEFAULT_LOCATION,
): Promise<string | null> {
  const res = await fetch(`${engineUrl(project, location, reasoningEngineId)}:query`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'create_session', input: { user_id: userId } }),
  });
  const text = await res.text();
  if (!res.ok) {
    logger.debug({ reasoningEngineId, status: res.status }, 'adkChat: create_session unsupported, continuing sessionless');
    return null;
  }
  return /"id":\s*"([^"]+)"/.exec(text)?.[1] ?? null;
}

/**
 * Send one message to a deployed ADK agent and return its reply.
 *
 * `sessionId` is optional — pass the one from a previous turn to continue a
 * conversation, or omit it and the agent creates a throwaway session.
 */
export async function chatWithAdkAgent(
  project: string,
  saToken: string,
  args: {
    reasoningEngineId: string;
    message: string;
    userId: string;
    sessionId?: string;
    location?: string;
  },
): Promise<AdkChatResult> {
  const location = args.location ?? DEFAULT_LOCATION;
  const input: Record<string, unknown> = { user_id: args.userId, message: args.message };
  if (args.sessionId) input.session_id = args.sessionId;

  const res = await fetch(`${engineUrl(project, location, args.reasoningEngineId)}:streamQuery?alt=sse`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ class_method: 'stream_query', input }),
  });
  const raw = await res.text();

  if (!res.ok) {
    const detail = errorDetail(raw);
    logger.warn({ reasoningEngineId: args.reasoningEngineId, status: res.status, detail }, 'adkChat: stream_query failed');
    return { ok: false, error: `${res.status}: ${detail}` };
  }

  // A 200 does NOT mean the agent answered. When the container throws (e.g. a
  // dependency clash breaking an import), the stream carries an error_code event
  // and no text at all — reporting that as a successful empty answer hides the
  // real failure, so surface it as an error instead.
  const errorCode = /"error_code":\s*"([^"]*)"/.exec(raw)?.[1];
  const errorMessage = /"error_message":\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1];
  if (errorCode) {
    logger.warn(
      { reasoningEngineId: args.reasoningEngineId, errorCode, errorMessage },
      'adkChat: agent returned an error event',
    );
    return { ok: false, error: `${errorCode}: ${errorMessage ?? 'no detail'}` };
  }

  const answer = extractText(raw);
  return {
    ok: true,
    answer,
    sessionId: args.sessionId,
    // VertexAiSearchTool shows up as a function call / grounding event in the stream.
    usedSearchTool: /vertex_ai_search|VertexAiSearch|functionCall|function_call|grounding/i.test(raw),
  };
}
