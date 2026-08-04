/**
 * MCP (Model Context Protocol) SSE endpoint.
 * Exposes migrated Cloud Workflow tools so any MCP-compatible agent
 * (Google Agent Studio, Claude, etc.) can call them.
 *
 * GET  /mcp       — SSE stream (MCP server)
 * POST /mcp       — MCP client messages
 */

import { Router } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { z } from 'zod';
import { readFileSync } from 'fs';
import { createSign } from 'crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';

export const mcpRouter = Router();

// Reuse SA token logic
async function getSaToken(): Promise<string> {
  const keyJson = config.GOOGLE_SA_KEY_JSON ??
    (config.GOOGLE_SA_KEY_FILE ? readFileSync(config.GOOGLE_SA_KEY_FILE, 'utf8') : null);
  if (!keyJson) throw new Error('No SA key configured');
  const key = JSON.parse(keyJson) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({
    iss: key.client_email, sub: key.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    iat: now, exp: now + 3600,
  })).toString('base64url');
  const s = createSign('RSA-SHA256').update(`${h}.${p}`).sign(key.private_key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${h}.${p}.${s}` }),
  });
  const j = await r.json() as { access_token?: string };
  if (!j.access_token) throw new Error('SA token failed');
  return j.access_token;
}

async function executeWorkflow(workflow: string, project: string, region: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const gcpToken = await getSaToken();
  const execUrl = `https://workflowexecutions.googleapis.com/v1/projects/${project}/locations/${region}/workflows/${workflow}/executions`;
  const execRes = await fetch(execUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${gcpToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ argument: JSON.stringify(args) }),
  });
  const exec = await execRes.json() as { name?: string; state?: string; error?: { message?: string } };
  if (!execRes.ok) throw new Error(exec.error?.message ?? 'Execution failed');

  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const poll = await fetch(`https://workflowexecutions.googleapis.com/v1/${exec.name!}`, {
      headers: { Authorization: `Bearer ${gcpToken}` },
    });
    const done = await poll.json() as { state?: string; result?: string; error?: { message?: string } };
    if (done.state === 'SUCCEEDED') return JSON.parse(done.result ?? '{}') as Record<string, unknown>;
    if (done.state === 'FAILED') throw new Error(done.error?.message ?? 'Workflow failed');
  }
  throw new Error('Workflow timed out');
}

// ── MCP Server factory ────────────────────────────────────────────────────────

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'studio-enterprise-migration',
    version: '1.0.0',
  });

  // Tool: create_task
  server.tool(
    'create_task',
    'Create a migration task by triggering the agent-create-task-demo Cloud Workflow.',
    {
      task_title: z.string().describe('Title of the task to create'),
      assigned_to: z.string().describe('Email of the person to assign the task to'),
      priority: z.string().describe('Priority: high, medium, or low'),
    },
    async ({ task_title, assigned_to, priority }) => {
      const result = await executeWorkflow(
        'agent-create-task-demo',
        config.GEMINI_PROJECT_FALLBACK ?? 'studio-enterprise-migration',
        'us-central1',
        { task_title, assigned_to, priority },
      );
      return {
        content: [{ type: 'text', text: String(result['message'] ?? JSON.stringify(result)) }],
      };
    },
  );

  // Tool: execute_workflow (generic — for any migrated workflow)
  server.tool(
    'execute_workflow',
    'Execute any migrated Cloud Workflow by name.',
    {
      workflow: z.string().describe('Cloud Workflow name (e.g. agent-create-task-demo)'),
      project: z.string().optional().describe('GCP project ID'),
      region: z.string().optional().describe('GCP region (default: us-central1)'),
      args: z.record(z.unknown()).optional().describe('Named arguments for the workflow'),
    },
    async ({ workflow, project, region, args }) => {
      const result = await executeWorkflow(
        workflow,
        project ?? config.GEMINI_PROJECT_FALLBACK ?? 'studio-enterprise-migration',
        region ?? 'us-central1',
        args ?? {},
      );
      return {
        content: [{ type: 'text', text: String(result['message'] ?? JSON.stringify(result)) }],
      };
    },
  );

  return server;
}

// ── SSE transport — one transport per connection ──────────────────────────────

const transports = new Map<string, SSEServerTransport>();

mcpRouter.get('/', async (_req, res) => {
  logger.info('MCP SSE connection opened');
  const transport = new SSEServerTransport('/mcp', res);
  const sessionId = transport.sessionId;
  transports.set(sessionId, transport);

  res.on('close', () => {
    transports.delete(sessionId);
    logger.info({ sessionId }, 'MCP SSE connection closed');
  });

  const server = createMcpServer();
  await server.connect(transport);
});

mcpRouter.post('/', async (req, res) => {
  const sessionId = req.query['sessionId'] as string;
  const transport = transports.get(sessionId);
  if (!transport) {
    return void res.status(404).json({ error: 'Session not found' });
  }
  await transport.handlePostMessage(req, res, req.body);
});
