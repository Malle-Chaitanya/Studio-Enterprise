/**
 * End-to-end test: provision Dialogflow CX agent → webhook → Cloud Workflow
 *
 * 1. Creates/updates the Dialogflow CX agent with tools for agent-create-task-demo
 * 2. Tests the webhook directly (simulates Dialogflow calling our server)
 * 3. Verifies the full loop: agent tool call → Cloud Run → Cloud Workflow → result
 *
 * Run: npx tsx src/_test_provision_agent.ts
 */

import { readFileSync } from 'fs';
import { createSign } from 'crypto';
import { provisionMigrationAgent } from './services/dialogflowProvisioner.js';

const SA_KEY_FILE = process.env['GOOGLE_SA_KEY_FILE']!;
const PROJECT = 'studio-enterprise-migration';
const LOCATION = 'us-central1';
const CLOUD_RUN_URL = 'https://studio-enterprise-server-231705905417.us-central1.run.app';

async function getSaToken(): Promise<string> {
  const key = JSON.parse(readFileSync(SA_KEY_FILE, 'utf8')) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({
    iss: key.client_email, sub: key.client_email,
    aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/cloud-platform https://www.googleapis.com/auth/dialogflow',
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
  console.log('=== Agent Provisioning + Full Loop Test ===\n');

  const gcpToken = await getSaToken();
  console.log('✓ SA token obtained\n');

  // ── Step 1: Provision the agent ──────────────────────────────────────────────
  console.log('Step 1: Provisioning Dialogflow CX agent...');

  const tools = [
    {
      displayName: 'Create Task',
      operationId: 'create_task',
      description: 'Creates a task with a title, assignee, and priority. Triggers the agent-create-task-demo Cloud Workflow.',
      gcpProject: PROJECT,
      gcpRegion: LOCATION,
      gcpWorkflow: 'agent-create-task-demo',
      params: {
        task_title: { type: 'string', description: 'Title of the task to create', required: true },
        assigned_to: { type: 'string', description: 'Email of the person to assign the task to', required: true },
        priority: { type: 'string', description: 'Priority: high, medium, or low', required: true },
      },
    },
  ];

  const webhookUrl = `${CLOUD_RUN_URL}/api/workflows/dialogflow-webhook`;

  const result = await provisionMigrationAgent({
    gcpToken,
    project: PROJECT,
    location: LOCATION,
    agentDisplayName: 'SE Migration Agent — Demo',
    tools,
    webhookUrl,
  });

  console.log(`✓ Agent provisioned`);
  console.log(`  Agent ID   : ${result.agentId}`);
  console.log(`  Webhook ID : ${result.webhookId}`);
  console.log(`  Tool IDs   : ${result.toolIds.join(', ')}`);
  console.log(`  Playbook ID: ${result.playbookId}`);
  console.log(`  Console URL: ${result.consoleUrl}`);

  // ── Step 2: Test webhook directly (simulates Dialogflow calling us) ──────────
  console.log('\nStep 2: Testing webhook (simulating Dialogflow tool call)...');

  const webhookPayload = {
    toolCall: {
      tool: `projects/${PROJECT}/locations/${LOCATION}/agents/${result.agentId}/tools/${result.toolIds[0]}`,
      action: 'create_task',
      inputParameters: {
        task_title: 'Migrate Contoso Power Automate flows',
        assigned_to: 'mia@cloudfuze.com',
        priority: 'high',
      },
    },
  };

  const webhookRes = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(webhookPayload),
  });

  const webhookResult = await webhookRes.json() as {
    toolCallResult?: { outputParameters?: { message?: string; state?: string } };
    error?: string;
  };

  if (!webhookRes.ok || webhookResult.error) {
    console.error('✗ Webhook failed:', webhookResult.error ?? webhookRes.status);
    process.exit(1);
  }

  const params = webhookResult.toolCallResult?.outputParameters ?? {};
  console.log(`✓ Webhook responded`);
  console.log(`  State  : ${params['state'] ?? 'unknown'}`);
  console.log(`  Message: ${params['message'] ?? JSON.stringify(params)}`);

  // ── Step 3: Test /execute endpoint ─────────────────────────────────────────
  console.log('\nStep 3: Testing /execute endpoint (Gemini Agent Builder HTTP tool)...');

  const execRes = await fetch(`${CLOUD_RUN_URL}/api/workflows/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      workflow: 'agent-create-task-demo',
      project: PROJECT,
      region: LOCATION,
      args: { task_title: 'Test from /execute', assigned_to: 'test@cloudfuze.com', priority: 'low' },
    }),
  });

  const execResult = await execRes.json() as { message?: string; state?: string; error?: string };
  if (!execRes.ok || execResult.error) {
    console.error('✗ /execute failed:', execResult.error ?? execRes.status);
  } else {
    console.log(`✓ /execute responded`);
    console.log(`  State  : ${execResult.state}`);
    console.log(`  Message: ${execResult.message}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log('\n=== READY FOR DEMO ===');
  console.log(`\nDialogflow CX Console (test agent conversation):`);
  console.log(`  ${result.consoleUrl}`);
  console.log(`\nTry: "Create a task for the Contoso migration, assign it to mia@cloudfuze.com, high priority"`);
  console.log(`\nAgent will:`);
  console.log(`  1. Collect task_title, assigned_to, priority`);
  console.log(`  2. Call Create Task tool → POST ${webhookUrl}`);
  console.log(`  3. Cloud Run executes agent-create-task-demo workflow`);
  console.log(`  4. Agent responds with: "Task '...' has been created and assigned to mia@cloudfuze.com with high priority."`);
}

main().catch(console.error);
export {};
