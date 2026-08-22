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
import { fetchTextTransient } from './httpTransient.js';

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
  /** A tool call failed inside the container (e.g. grounding 403). The model may still
   *  have produced a plausible-sounding answer, so callers must check this. */
  toolError?: string;
  /** The turn contains at least one tool invocation (function call, or a retrieval the
   *  runtime performed itself). False means the model answered from its instruction alone. */
  toolCalled?: boolean;
  /** The turn contains positive evidence a tool RETURNED DATA — a `function_response`
   *  that is not an error, or grounding chunks / retrieved context. This, not the
   *  model's prose, is what proves knowledge sources are actually reachable. */
  toolSucceeded?: boolean;
  sessionId?: string;
  /** True when the agent's VertexAiSearchTool was invoked for this turn. */
  usedSearchTool?: boolean;
  /**
   * Names of the tools the runtime invoked this turn, read from the `function_call`
   * frames rather than from the model's prose.
   *
   * This is the only trustworthy statement about which tools a deployed agent HAS: ADK
   * bakes tools into the Reasoning Engine pickle at deploy time, so there is no API that
   * lists them. A name appearing here is proof that tool exists on the deployment and
   * that the model can reach it.
   */
  toolNames?: string[];
  error?: string;
}

export interface ToolEvidence {
  called: boolean;
  succeeded: boolean;
  error?: string;
  /** Names of the tools the runtime actually invoked this turn, deduped. */
  names: string[];
}

function unescapeJsonString(s: string): string {
  try {
    return JSON.parse(`"${s}"`) as string;
  } catch {
    return s;
  }
}

/**
 * Read what the tools actually did, structurally.
 *
 * Tool failures do NOT surface as HTTP errors or as text the model reliably repeats —
 * the model often just says something evasive like "I cannot list specific documents".
 * The truth is in the runtime's own `function_response`, which carries the tool's error
 * verbatim (e.g. `403 Permission 'discoveryengine.servingConfigs.search' denied`).
 *
 * The ABSENCE of a successful response matters just as much: an agent given knowledge
 * sources that answers without ever retrieving is not a working agent, it is a model
 * improvising from its instruction. Callers must be able to tell those apart, so we
 * report `succeeded` separately from `error` rather than collapsing both into "no error".
 *
 * Two shapes count as success because ADK emits both depending on how the tool is wired:
 * an explicit non-error `function_response`, and model-side retrieval that appears only
 * as grounding chunks / retrieved context.
 */
export function scanToolEvidence(raw: string): ToolEvidence {
  const responseIdx: number[] = [];
  const reResp = /"function_response"|"functionResponse"/g;
  let m: RegExpExecArray | null;
  while ((m = reResp.exec(raw)) !== null) responseIdx.push(m.index);

  let succeeded = false;
  let error: string | undefined;
  for (let i = 0; i < responseIdx.length; i++) {
    // Bound each window at the NEXT response so one failing tool cannot be masked by a
    // neighbouring successful one (and vice versa).
    const start = responseIdx[i];
    const end = Math.min(responseIdx[i + 1] ?? raw.length, start + 4000);
    const window = raw.slice(start, end);
    // `"error":` is the convention EVERY connector tool in scripts/connector_tools/ uses to
    // report failure (`return {"error": "..."}`). Without it a tool that failed cleanly —
    // bad credential, missing scope, 403 from the upstream API — arrives as a perfectly
    // well-formed function_response and was counted as SUCCESS. Measured live on
    // 2026-08-19: a deployed agent answered "the authentication to Outlook failed" while
    // this function reported succeeded=true, so verify.ts would have marked it verified.
    const failed =
      /"status":\s*"error"|IAM_PERMISSION_DENIED|PERMISSION_DENIED|"error_message"|"error":\s*"/i.test(
        window,
      );
    if (failed) {
      if (!error) {
        const msg =
          /"error_message":\s*"((?:[^"\\]|\\.)*)"/.exec(window)?.[1] ??
          /"error":\s*"((?:[^"\\]|\\.)*)"/.exec(window)?.[1];
        error = msg ? unescapeJsonString(msg) : 'tool returned an error';
      }
    } else {
      succeeded = true;
    }
  }

  // Retrieval the runtime performed itself leaves no function_response — only chunks.
  // Require the chunks, not a bare `groundingMetadata` key, which is emitted empty.
  const grounded = /"grounding_chunks"|"groundingChunks"|"retrieved_context"|"retrievedContext"/.test(raw);
  if (grounded) succeeded = true;

  const called = responseIdx.length > 0 || grounded || /"function_call"|"functionCall"/.test(raw);

  // Tool names, from the call frames. Both spellings appear depending on how the runtime
  // serialises the turn, and the `name` key can precede or follow `args`, so the window is
  // scanned rather than assuming a fixed field order.
  const names = new Set<string>();
  const reCall = /"(?:function_call|functionCall)"\s*:\s*\{/g;
  let c: RegExpExecArray | null;
  while ((c = reCall.exec(raw)) !== null) {
    const window = raw.slice(c.index, c.index + 400);
    const name = /"name"\s*:\s*"([^"\\]{1,120})"/.exec(window)?.[1];
    if (name) names.add(name);
  }

  return { called, succeeded, error, names: [...names] };
}

/** Which class methods does this deployment expose? */
export async function getReasoningEngineMethods(
  project: string,
  saToken: string,
  reasoningEngineId: string,
  location = DEFAULT_LOCATION,
): Promise<{ methods: string[]; framework?: string; displayName?: string } | null> {
  const r = await fetchTextTransient(
    engineUrl(project, location, reasoningEngineId),
    { headers: { Authorization: `Bearer ${saToken}` } },
    { label: 'adkChat: get_engine' },
  );
  if (!r.ok || r.status < 200 || r.status >= 300) return null;
  let json: {
    displayName?: string;
    spec?: { agentFramework?: string; classMethods?: Array<{ name?: string }> };
  };
  try {
    json = JSON.parse(r.text);
  } catch {
    // A 2xx that isn't JSON means we cannot say what the deployment exposes. Null is the
    // honest answer; inventing an empty method list would read as "supports nothing".
    return null;
  }
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
  // A THROWN fetch (TLS reset, DNS blip) must degrade to "no session", not crash the
  // caller — sessions are an optimisation for multi-turn history, and stream_query works
  // without one. An unhandled ECONNRESET here took down a whole deploy run whose agent
  // had already been created successfully.
  const r = await fetchTextTransient(
    `${engineUrl(project, location, reasoningEngineId)}:query`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ class_method: 'create_session', input: { user_id: userId } }),
    },
    { label: 'adkChat: create_session' },
  );
  if (!r.ok) {
    logger.warn({ reasoningEngineId, err: r.error }, 'adkChat: create_session request failed, continuing sessionless');
    return null;
  }
  if (r.status < 200 || r.status >= 300) {
    logger.debug({ reasoningEngineId, status: r.status }, 'adkChat: create_session unsupported, continuing sessionless');
    return null;
  }
  return /"id":\s*"([^"]+)"/.exec(r.text)?.[1] ?? null;
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

  // Same reasoning as createAdkSession: a network-level failure is an error to REPORT,
  // never an exception that escapes into a route handler or migration run.
  const r = await fetchTextTransient(
    `${engineUrl(project, location, args.reasoningEngineId)}:streamQuery?alt=sse`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${saToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ class_method: 'stream_query', input }),
    },
    { label: 'adkChat: stream_query' },
  );
  if (!r.ok) {
    logger.warn({ reasoningEngineId: args.reasoningEngineId, err: r.error }, 'adkChat: stream_query request failed');
    return { ok: false, error: `network: ${r.error}` };
  }
  const raw = r.text;

  if (r.status < 200 || r.status >= 300) {
    const detail = errorDetail(raw);
    logger.warn({ reasoningEngineId: args.reasoningEngineId, status: r.status, detail }, 'adkChat: stream_query failed');
    return { ok: false, error: `${r.status}: ${detail}` };
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

  // What the tools actually did — read structurally, never inferred from the prose.
  const evidence = scanToolEvidence(raw);

  const answer = extractText(raw);
  return {
    ok: true,
    answer,
    toolError: evidence.error,
    toolCalled: evidence.called,
    toolSucceeded: evidence.succeeded,
    toolNames: evidence.names,
    sessionId: args.sessionId,
    // VertexAiSearchTool shows up as a function call or as a grounding event in the stream.
    usedSearchTool: evidence.called || /vertex_ai_search|VertexAiSearch|grounding/i.test(raw),
  };
}
