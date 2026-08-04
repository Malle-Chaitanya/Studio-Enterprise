/**
 * Simulate what happens when a Dialogflow CX agent collects params from user
 * and triggers the agent-create-task-demo Cloud Workflow.
 *
 * This tests the execution path WITHOUT needing HTTPS webhook.
 * The agent conversation part is tested via Dialogflow CX console simulator.
 *
 * Run: npx tsx src/_test_agent_workflow.ts
 */

import { readFileSync } from 'fs';
import { createSign } from 'crypto';

const SA_KEY_FILE = process.env['GOOGLE_SA_KEY_FILE']!;
const GCP_PROJECT = 'studio-enterprise-migration';
const REGION = 'us-central1';
const WORKFLOW = 'agent-create-task-demo';

async function getSaToken(): Promise<string> {
  const key = JSON.parse(readFileSync(SA_KEY_FILE, 'utf8')) as { client_email: string; private_key: string };
  const now = Math.floor(Date.now() / 1000);
  const h = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const p = Buffer.from(JSON.stringify({
    iss: key.client_email, aud: 'https://oauth2.googleapis.com/token',
    scope: 'https://www.googleapis.com/auth/cloud-platform', iat: now, exp: now + 3600,
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

async function main() {
  console.log('=== Agent → Cloud Workflow End-to-End Test ===\n');

  // Simulate what Dialogflow agent collects from user conversation
  console.log('Simulated conversation:');
  console.log('  User  : "Create a migration task for Contoso"');
  console.log('  Agent : "What should the task be called?"');
  console.log('  User  : "Migrate Contoso Power Automate flows to GCP"');
  console.log('  Agent : "Who should it be assigned to?"');
  console.log('  User  : "mia@cloudfuze.com"');
  console.log('  Agent : "What priority? high, medium, or low?"');
  console.log('  User  : "high"');
  console.log('  Agent : [calls create_task tool...]\n');

  // These are the params the agent extracted → would pass to our webhook → we run workflow
  const agentParams = {
    task_title: 'Migrate Contoso Power Automate flows to GCP',
    assigned_to: 'mia@cloudfuze.com',
    priority: 'high',
  };

  console.log('Params agent collected:', JSON.stringify(agentParams, null, 2));
  console.log('\nTriggering Cloud Workflow...');

  const token = await getSaToken();
  const execUrl = `https://workflowexecutions.googleapis.com/v1/projects/${GCP_PROJECT}/locations/${REGION}/workflows/${WORKFLOW}/executions`;

  const execRes = await fetch(execUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ argument: JSON.stringify(agentParams) }),
  });

  const exec = await execRes.json() as { name?: string; state?: string };
  if (!execRes.ok) throw new Error(`Execution failed: ${JSON.stringify(exec)}`);

  const execId = exec.name?.split('/').pop();
  console.log(`✓ Execution started: ${execId} (${exec.state})`);
  console.log('Waiting for result...');

  // Poll for completion
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1500));
    const pollRes = await fetch(`https://workflowexecutions.googleapis.com/v1/${exec.name}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const done = await pollRes.json() as { state?: string; result?: string; error?: { message?: string } };
    if (done.state === 'SUCCEEDED') {
      const result = JSON.parse(done.result ?? '{}') as { message?: string; status?: string; task_title?: string; assigned_to?: string };
      console.log('\n=== Workflow Result ===');
      console.log(`State    : ${done.state}`);
      console.log(`Status   : ${result.status}`);
      console.log(`Message  : ${result.message}`);
      console.log('\n=== Agent replies to user ===');
      console.log(`"${result.message}"`);
      console.log('\n✅ End-to-end verified. Agent → Workflow → Result works.');
      return;
    }
    if (done.state === 'FAILED') {
      throw new Error(`Workflow failed: ${done.error?.message}`);
    }
    process.stdout.write('.');
  }
  console.log('\nTimed out waiting for result.');
}

main().catch(console.error);
export {};
