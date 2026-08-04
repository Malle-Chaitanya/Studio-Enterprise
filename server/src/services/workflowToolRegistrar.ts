/**
 * Registers migrated Cloud Workflows as tools in a Vertex AI Agent Builder agent.
 *
 * Flow:
 *   1. Generate an OpenAPI 3.0 tool spec from the FlowIR (args schema + description)
 *   2. POST the tool to the Vertex AI Agent Builder tools collection
 *   3. PATCH the Gemini agent to add the tool to its selectedTools list
 *
 * The tool calls the Cloud Workflow Executions API — the agent passes arguments,
 * the workflow runs, the result is returned to the agent.
 *
 * API reference:
 *   https://cloud.google.com/dialogflow/cx/docs/reference/rest/v3/projects.locations.agents.tools
 *   https://cloud.google.com/dialogflow/cx/docs/how-to/tools
 */

import type { FlowIR } from '../types.js';

const DF_BASE = 'https://dialogflow.googleapis.com/v3';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface WorkflowToolSpec {
  /** Dialogflow CX tool resource name */
  toolName: string;
  /** OpenAPI spec as object */
  openApiSpec: Record<string, unknown>;
  /** Cloud Workflow execution URL the tool calls */
  workflowExecutionUrl: string;
}

export interface RegisterToolResult {
  toolName:    string;
  toolId:      string;
  displayName: string;
}

// ── OpenAPI spec generation ───────────────────────────────────────────────────

/**
 * Generate an OpenAPI 3.0 spec for a Cloud Workflow.
 *
 * For Manual trigger flows (originally "Manually trigger a flow" in PA):
 *   - Named input parameters are extracted from FlowIR.trigger.inputs
 *   - The spec points to a proxy endpoint on our server that accepts named params,
 *     serialises them to the `argument` JSON string, and calls the Workflow
 *     Executions API. This lets Gemini agents know EXACTLY what to ask the user.
 *
 * For all other triggers (Recurrence, Webhook, HttpRequest):
 *   - Generic `argument` body pointing straight to Workflow Executions API.
 *
 * @param serverBaseUrl  Public base URL of this server (e.g. "https://api.example.com").
 *                       Used as the proxy endpoint host for Manual triggers.
 */
export function generateWorkflowToolSpec(
  ir: FlowIR,
  gcpProject: string,
  gcpRegion: string,
  workflowName: string,
  serverBaseUrl = 'http://localhost:8080',
): WorkflowToolSpec {
  const execUrl = `https://workflowexecutions.googleapis.com/v1/projects/${gcpProject}/locations/${gcpRegion}/workflows/${workflowName}/executions`;
  const toolName = workflowName.replace(/[^a-z0-9_-]/gi, '_').toLowerCase().substring(0, 64);
  const description = `Executes the migrated Cloud Workflow "${ir.name}". Originally a Power Automate flow. Trigger: ${ir.trigger.type}.`;

  // ── Manual trigger: named params via our proxy ──────────────────────────────
  if (ir.trigger.type === 'Manual' && ir.trigger.inputs && Object.keys(ir.trigger.inputs).length > 0) {
    const namedProps: Record<string, { type: string; description: string }> = {};
    const requiredFields: string[] = [];

    for (const [key, field] of Object.entries(ir.trigger.inputs)) {
      const paramName = key.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
      namedProps[paramName] = {
        type: field.type,
        description: field.description ?? paramName,
      };
      if (field.required) requiredFields.push(paramName);
    }

    const proxyPath = `/api/workflows/trigger/${gcpProject}/${gcpRegion}/${workflowName}`;

    const openApiSpec = {
      openapi: '3.0.0',
      info: { title: toolName, version: '1.0.0', description },
      servers: [{ url: serverBaseUrl }],
      paths: {
        [proxyPath]: {
          post: {
            operationId: `trigger_${toolName}`,
            summary: description,
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: namedProps,
                    ...(requiredFields.length > 0 ? { required: requiredFields } : {}),
                  },
                },
              },
            },
            responses: {
              '200': {
                description: 'Workflow triggered successfully',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        executionName: { type: 'string' },
                        state: { type: 'string' },
                        result: { type: 'string' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };

    return { toolName, openApiSpec, workflowExecutionUrl: execUrl };
  }

  // ── All other triggers: generic argument → Workflow Executions API directly ─
  const properties: Record<string, { type: string; description: string }> = {};

  if (ir.trigger.type === 'HttpRequest' || ir.trigger.type === 'Webhook') {
    properties['body'] = { type: 'object', description: 'Request body passed to the workflow' };
  }

  // Surface any named args from action rawInputs (best-effort)
  for (const action of ir.actions.slice(0, 5)) {
    for (const [key, val] of Object.entries(action.rawInputs ?? {})) {
      if (typeof val === 'string' && val.startsWith('${')) {
        const paramName = key.replace(/[^a-zA-Z0-9_]/g, '_').toLowerCase();
        if (!properties[paramName]) {
          properties[paramName] = {
            type: 'string',
            description: `${key} — input for "${action.type}" action`,
          };
        }
      }
    }
  }

  if (Object.keys(properties).length === 0) {
    properties['input'] = { type: 'object', description: 'Input data for the workflow' };
  }

  const openApiSpec = {
    openapi: '3.0.0',
    info: { title: toolName, version: '1.0.0', description },
    servers: [{ url: 'https://workflowexecutions.googleapis.com' }],
    paths: {
      [`/v1/projects/${gcpProject}/locations/${gcpRegion}/workflows/${workflowName}/executions`]: {
        post: {
          operationId: `execute_${toolName}`,
          summary: description,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    argument: {
                      type: 'string',
                      description: `JSON-serialized arguments. Expected shape: ${JSON.stringify(Object.keys(properties))}`,
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Workflow execution created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      state: { type: 'string', description: 'ACTIVE | SUCCEEDED | FAILED | CANCELLED' },
                      result: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
          security: [{ oauth2: ['https://www.googleapis.com/auth/cloud-platform'] }],
        },
      },
    },
    components: {
      securitySchemes: {
        oauth2: {
          type: 'oauth2',
          flows: {
            clientCredentials: {
              tokenUrl: 'https://oauth2.googleapis.com/token',
              scopes: { 'https://www.googleapis.com/auth/cloud-platform': 'GCP access' },
            },
          },
        },
      },
    },
  };

  return { toolName, openApiSpec, workflowExecutionUrl: execUrl };
}

// ── Dialogflow CX tool registration ──────────────────────────────────────────

/**
 * Register a Cloud Workflow as a Dialogflow CX tool.
 * Uses the OpenAPI tool type — Dialogflow calls the workflow execution API directly.
 *
 * @param gcpToken    OAuth2 token with dialogflow.admin scope
 * @param dfProject   GCP project with the Dialogflow CX agent
 * @param dfLocation  Dialogflow CX location (e.g. "us-central1" or "global")
 * @param dfAgentId   Dialogflow CX agent UUID
 * @param spec        Generated from generateWorkflowToolSpec()
 */
export async function registerWorkflowTool(
  gcpToken: string,
  dfProject: string,
  dfLocation: string,
  dfAgentId: string,
  spec: WorkflowToolSpec,
  displayName: string,
): Promise<RegisterToolResult> {
  const toolsBase = `${DF_BASE}/projects/${dfProject}/locations/${dfLocation}/agents/${dfAgentId}/tools`;

  const body = {
    displayName,
    description: (spec.openApiSpec['info'] as { description: string }).description,
    openApiSpec: {
      textSchema: JSON.stringify(spec.openApiSpec),
    },
  };

  const res = await fetch(toolsBase, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${gcpToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Tool registration failed (${res.status}): ${t.substring(0, 400)}`);
  }

  const tool = await res.json() as { name: string; displayName: string };
  const toolId = tool.name.split('/').pop() ?? '';

  return { toolName: tool.name, toolId, displayName: tool.displayName };
}

/**
 * Attach a registered tool to a Dialogflow CX agent's tool list.
 * Fetches the current agent, merges the tool, then PATCHes.
 */
export async function attachToolToAgent(
  gcpToken: string,
  dfProject: string,
  dfLocation: string,
  dfAgentId: string,
  toolName: string,
): Promise<void> {
  const agentUrl = `${DF_BASE}/projects/${dfProject}/locations/${dfLocation}/agents/${dfAgentId}`;
  const headers = { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' };

  const agentRes = await fetch(agentUrl, { headers: { Authorization: `Bearer ${gcpToken}` } });
  if (!agentRes.ok) throw new Error(`GET agent failed (${agentRes.status}): ${await agentRes.text()}`);
  const agent = await agentRes.json() as { toolInstances?: Array<{ tool: string }> };

  const existing = agent.toolInstances ?? [];
  const alreadyAttached = existing.some(t => t.tool === toolName);
  if (alreadyAttached) return;

  const updated = { toolInstances: [...existing, { tool: toolName }] };

  const patchRes = await fetch(`${agentUrl}?updateMask=toolInstances`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify(updated),
  });
  if (!patchRes.ok) {
    const t = await patchRes.text();
    throw new Error(`PATCH agent tools failed (${patchRes.status}): ${t.substring(0, 400)}`);
  }
}

// ── Discovery Engine (Agentspace) tool registration ──────────────────────────
// Vertex AI Agent Builder (Agentspace) uses a different API from Dialogflow CX.
// This is for the existing gemini.ts-style agents using discoveryengine.

/**
 * Register a Cloud Workflow as a tool in a Vertex AI Agent Builder (Agentspace) agent.
 * The tool is an OpenAPI tool that calls the Cloud Workflow Executions API.
 *
 * @param gcpToken   OAuth2 token with cloud-platform scope
 * @param project    GCP project
 * @param engine     Engine ID (e.g. "agentspace-engine")
 * @param assistant  Assistant ID (e.g. "default_assistant")
 * @param agentId    Agent resource ID
 * @param spec       Generated tool spec
 */
export async function registerWorkflowToolAgentspace(
  gcpToken: string,
  project: string,
  engine: string,
  assistant: string,
  agentId: string,
  spec: WorkflowToolSpec,
  displayName: string,
): Promise<{ toolId: string; toolName: string }> {
  const LOCATION = 'global';
  const base = `https://discoveryengine.googleapis.com/v1alpha/projects/${project}/locations/${LOCATION}/collections/default_collection/engines/${engine}/assistants/${assistant}/agents/${agentId}`;

  // Get current agent
  const agentRes = await fetch(base, {
    headers: { Authorization: `Bearer ${gcpToken}` },
  });
  if (!agentRes.ok) throw new Error(`GET agent failed: ${await agentRes.text()}`);
  const agentBody = await agentRes.json() as {
    tools?: Array<{ openApiToolSpec?: string; displayName?: string }>;
  };

  const existingTools = agentBody.tools ?? [];
  const alreadyExists = existingTools.some(t => t.displayName === displayName);
  if (alreadyExists) {
    return { toolId: displayName, toolName: displayName };
  }

  const newTool = {
    displayName,
    openApiToolSpec: JSON.stringify(spec.openApiSpec),
  };

  const updated = { tools: [...existingTools, newTool] };

  const patchRes = await fetch(`${base}?updateMask=tools`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(updated),
  });
  if (!patchRes.ok) {
    const t = await patchRes.text();
    throw new Error(`PATCH agent tools failed (${patchRes.status}): ${t.substring(0, 400)}`);
  }

  return { toolId: displayName, toolName: displayName };
}

// ── Convenience: register + attach in one call ────────────────────────────────

export interface WorkflowToolRegistrationOpts {
  gcpToken:    string;
  gcpProject:  string;
  gcpRegion:   string;
  workflowName: string;
  ir:          FlowIR;
  /** Dialogflow CX agent (if using CX) */
  dfAgent?: {
    project:  string;
    location: string;
    agentId:  string;
  };
  /** Agentspace agent (if using discoveryengine) */
  agentspaceAgent?: {
    project:   string;
    engine:    string;
    assistant: string;
    agentId:   string;
  };
}

export async function registerAndAttachWorkflowTool(
  opts: WorkflowToolRegistrationOpts,
): Promise<{ toolId: string; toolName: string; spec: WorkflowToolSpec }> {
  const spec = generateWorkflowToolSpec(opts.ir, opts.gcpProject, opts.gcpRegion, opts.workflowName);
  const displayName = opts.ir.name.substring(0, 64);

  if (opts.dfAgent) {
    const result = await registerWorkflowTool(
      opts.gcpToken,
      opts.dfAgent.project,
      opts.dfAgent.location,
      opts.dfAgent.agentId,
      spec,
      displayName,
    );
    await attachToolToAgent(
      opts.gcpToken,
      opts.dfAgent.project,
      opts.dfAgent.location,
      opts.dfAgent.agentId,
      result.toolName,
    );
    return { toolId: result.toolId, toolName: result.toolName, spec };
  }

  if (opts.agentspaceAgent) {
    const a = opts.agentspaceAgent;
    const result = await registerWorkflowToolAgentspace(
      opts.gcpToken, a.project, a.engine, a.assistant, a.agentId, spec, displayName,
    );
    return { toolId: result.toolId, toolName: result.toolName, spec };
  }

  throw new Error('Must provide either dfAgent or agentspaceAgent opts');
}
