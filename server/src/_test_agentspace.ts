/**
 * Create a Gemini Enterprise (Agentspace) agent in studioenterprisemigrations
 * with a tool that triggers Cloud Workflows via our Cloud Run server.
 *
 * Run: npx tsx src/_test_agentspace.ts
 */

import { readFileSync } from 'fs';
import { createSign } from 'crypto';

const SA_KEY_FILE = process.env['GOOGLE_SA_KEY_FILE']!;
const CUSTOMER_PROJECT = 'studioenterprisemigrations';
const CLOUD_RUN_URL = 'https://studio-enterprise-server-231705905417.us-central1.run.app';

async function getSaToken(): Promise<string> {
  const key = JSON.parse(readFileSync(SA_KEY_FILE, 'utf8')) as { client_email: string; private_key: string };
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
  const j = await r.json() as { access_token?: string; error_description?: string };
  if (!j.access_token) throw new Error(`SA token failed: ${j.error_description}`);
  return j.access_token;
}

async function main() {
  console.log('=== Gemini Enterprise (Agentspace) Agent Creation ===\n');

  const token = await getSaToken();
  console.log('✓ SA token obtained');

  const BASE = `https://discoveryengine.googleapis.com/v1alpha/projects/${CUSTOMER_PROJECT}/locations/global/collections/default_collection`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  // ── Step 1: List engines ──────────────────────────────────────────────────
  console.log('\nStep 1: Listing Agentspace engines...');
  const enginesRes = await fetch(`${BASE}/engines`, { headers });
  const enginesBody = await enginesRes.json() as {
    engines?: Array<{ name: string; displayName: string; solutionType?: string }>;
    error?: { message: string; code: number };
  };

  if (!enginesRes.ok) {
    console.error('✗ List engines failed:', enginesBody.error?.message ?? enginesRes.status);
    console.log('\nFull response:', JSON.stringify(enginesBody, null, 2));
    process.exit(1);
  }

  const engines = enginesBody.engines ?? [];
  console.log(`Found ${engines.length} engine(s):`);
  engines.forEach(e => console.log(`  - ${e.displayName} (${e.name.split('/').pop()}) type=${e.solutionType}`));

  if (engines.length === 0) {
    console.log('\nNo engines found. Need to create one or Discovery Engine API not enabled.');
    process.exit(1);
  }

  // Use first engine (or find Agentspace one)
  const engine = engines.find(e => e.solutionType === 'SOLUTION_TYPE_GENERATIVE_CHAT') ?? engines[0]!;
  const engineId = engine.name.split('/').pop()!;
  console.log(`\nUsing engine: ${engine.displayName} (${engineId})`);

  // ── Step 2: List or create agent ─────────────────────────────────────────
  console.log('\nStep 2: Finding/creating agent...');
  const agentsBase = `${BASE}/engines/${engineId}/assistants/default_assistant/agents`;

  const agentsRes = await fetch(agentsBase, { headers });
  const agentsBody = await agentsRes.json() as {
    agents?: Array<{ name: string; displayName: string }>;
    error?: { message: string };
  };

  if (!agentsRes.ok) {
    console.log('List agents failed:', agentsBody.error?.message);
    console.log('Trying to create agent directly...');
  }

  const existingAgents = agentsBody.agents ?? [];
  const existingAgent = existingAgents.find(a => a.displayName === 'Studio Enterprise Migration Agent');

  let agentName: string;

  if (existingAgent) {
    agentName = existingAgent.name;
    console.log(`✓ Reusing existing agent: ${agentName.split('/').pop()}`);
  } else {
    console.log('Creating new agent...');
    const createRes = await fetch(agentsBase, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        displayName: 'Studio Enterprise Migration Agent',
        description: 'Triggers migrated Cloud Workflows. Auto-provisioned by CloudFuze Studio Migrate.',
      }),
    });
    const created = await createRes.json() as { name?: string; error?: { message: string } };
    if (!createRes.ok) {
      console.error('✗ Create agent failed:', created.error?.message ?? createRes.status);
      console.log('Response:', JSON.stringify(created, null, 2));
      process.exit(1);
    }
    agentName = created.name!;
    console.log(`✓ Agent created: ${agentName.split('/').pop()}`);
  }

  // ── Step 3: Add tool to agent ─────────────────────────────────────────────
  console.log('\nStep 3: Adding workflow tool to agent...');

  const toolSpec = {
    openapi: '3.0.0',
    info: {
      title: 'create-task',
      version: '1.0.0',
      description: 'Creates a task by triggering the agent-create-task-demo Cloud Workflow.',
    },
    servers: [{ url: CLOUD_RUN_URL }],
    paths: {
      '/api/workflows/execute': {
        post: {
          operationId: 'create_task',
          summary: 'Create a migration task',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    workflow: { type: 'string', default: 'agent-create-task-demo' },
                    project:  { type: 'string', default: 'studio-enterprise-migration' },
                    region:   { type: 'string', default: 'us-central1' },
                    args: {
                      type: 'object',
                      properties: {
                        task_title:  { type: 'string', description: 'Title of the task' },
                        assigned_to: { type: 'string', description: 'Email to assign the task to' },
                        priority:    { type: 'string', description: 'high, medium, or low' },
                      },
                      required: ['task_title', 'assigned_to', 'priority'],
                    },
                  },
                },
              },
            },
          },
          responses: {
            '200': {
              description: 'Task created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status:  { type: 'string' },
                      message: { type: 'string' },
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

  const patchRes = await fetch(`${agentName}?updateMask=tools`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({
      tools: [{
        displayName: 'Create Task',
        openApiToolSpec: JSON.stringify(toolSpec),
      }],
    }),
  });

  const patchBody = await patchRes.json() as { name?: string; tools?: unknown[]; error?: { message: string } };
  if (!patchRes.ok) {
    console.error('✗ Add tool failed:', patchBody.error?.message ?? patchRes.status);
    console.log('Response:', JSON.stringify(patchBody, null, 2));
    process.exit(1);
  }

  console.log(`✓ Tool added. Agent has ${(patchBody.tools ?? []).length} tool(s)`);

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n=== DONE ===');
  console.log(`\nAgent visible in Gemini Enterprise:`);
  console.log(`  business.gemini.google → Agents sidebar → "Studio Enterprise Migration Agent"`);
  console.log(`\nTest it: ask "Create a task for Contoso migration, assign to mia@cloudfuze.com, high priority"`);
}

main().catch(console.error);
export {};
